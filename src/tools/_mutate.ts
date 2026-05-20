/**
 * @file _mutate.ts — single source of truth for routine create/delete mutations.
 *
 * Both the LLM-callable tools (routine-create, routine-delete) and the
 * user-facing slash commands (/routine, /routine-on, /routine-install,
 * /routine-stop) call into these helpers. They own:
 *   - name validation
 *   - interval parsing
 *   - agent_end uniqueness + global-cap checks
 *   - upsert semantics (preserve id/createdAt/tickState on update)
 *   - timer (re)scheduling / unscheduling
 *   - persistence via `saveStore`
 *
 * The thin wrappers above (tool `execute` bodies, command `handler` bodies)
 * are responsible only for argument shape validation and surfacing the
 * `{ error }` / success payloads in their respective UIs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { describeTrigger, describeTriggers } from "../format.ts";
import { parseInterval } from "../parser.ts";
import { scheduleRoutine, unscheduleRoutine } from "../scheduler.ts";
import { saveStore } from "../store.ts";
import type { HookEvent, Routine, RoutineRuntimeState, RoutineTrigger } from "../types.ts";
import {
	listRoutineNames as listRoutineNamesFromStore,
	resolveRoutine as resolveFromStore,
} from "./_resolve.ts";

// Re-export so existing callers that imported these from `_mutate.ts` keep
// working without code churn. The single implementations live in `_resolve.ts`
// and `format.ts` respectively.
export { describeTrigger, describeTriggers };

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const MAX_ROUTINES = 20;

/** Inputs accepted by {@link createRoutine}. Trigger uses raw (pre-parse) shape. */
export interface CreateRoutineInput {
	name: string;
	prompt: string;
	trigger:
		| { kind: "pulse"; interval: string }
		| { kind: "hook"; event: HookEvent; once?: "daily" | "per_session" };
	quiet?: boolean;
	maxTicks?: number;
}

export interface CreateRoutineSuccess {
	id: string;
	name: string;
	triggerDescription: string;
	/** Present only for pulse routines. */
	nextFireIn?: string;
	/** True if this updated an existing routine (same name); false if new. */
	updated: boolean;
}

export interface MutateError {
	error: string;
}

export type CreateRoutineResult = CreateRoutineSuccess | MutateError;

export interface DeleteRoutineSuccess {
	deletedId: string;
	deletedName: string;
}

export type DeleteRoutineResult = DeleteRoutineSuccess | MutateError;

/**
 * Resolve a routine by id-or-name (runtime-keyed convenience for callers
 * that hold a runtime rather than a bare store). Returns `undefined` when
 * nothing matches.
 *
 * Thin wrapper over the canonical {@link resolveFromStore}; kept for
 * source compatibility with the v0.1 call sites.
 */
export function resolveRoutine(
	idOrName: string,
	runtime: RoutineRuntimeState,
): Routine | undefined {
	if (!idOrName) return undefined;
	return resolveFromStore(runtime.store, idOrName) ?? undefined;
}

/** Comma-separated list of current routine names (for "not found" errors). */
export function listRoutineNames(runtime: RoutineRuntimeState): string {
	return listRoutineNamesFromStore(runtime.store);
}

/**
 * Create or update a routine (upsert by name). Persists, (re)schedules
 * pulse timers, and enforces all invariants (name shape, interval bounds,
 * agent_end uniqueness, global cap).
 */
export async function createRoutine(
	input: CreateRoutineInput,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): Promise<CreateRoutineResult> {
	const { name, prompt, trigger, quiet, maxTicks } = input;

	if (!NAME_RE.test(name)) {
		return {
			error: `Invalid name '${name}'. Use lowercase letters, digits, and hyphens (max 32 chars).`,
		};
	}

	// Resolve trigger; pulse triggers may throw via parseInterval.
	let resolvedTrigger: RoutineTrigger;
	if (trigger.kind === "pulse") {
		try {
			const parsed = parseInterval(trigger.interval);
			resolvedTrigger = {
				kind: "pulse",
				intervalMs: parsed.ms,
				intervalHuman: parsed.human,
			};
		} catch (err) {
			return { error: (err as Error).message };
		}
	} else {
		resolvedTrigger = {
			kind: "hook",
			event: trigger.event,
			...(trigger.once ? { once: trigger.once } : {}),
		};
	}

	const existing = Object.values(runtime.store.routines).find((r) => r.name === name);

	if (resolvedTrigger.kind === "hook" && resolvedTrigger.event === "agent_end") {
		const conflict = Object.values(runtime.store.routines).find(
			(r) =>
				r.id !== existing?.id &&
				r.triggers.some((t) => t.kind === "hook" && t.event === "agent_end"),
		);
		if (conflict) {
			return {
				error:
					`Another routine ('${conflict.name}') already uses the agent_end hook. ` +
					"Delete it first or pick a different event.",
			};
		}
	}

	if (!existing && Object.keys(runtime.store.routines).length >= MAX_ROUTINES) {
		return {
			error: `Routine limit reached (${MAX_ROUTINES}). Delete an existing routine first.`,
		};
	}

	let routine: Routine;
	if (existing) {
		routine = {
			...existing,
			prompt,
			triggers: [resolvedTrigger],
			quiet: quiet ?? existing.quiet ?? false,
			...(maxTicks !== undefined ? { maxTicks } : { maxTicks: existing.maxTicks }),
		};
		unscheduleRoutine(existing.id, runtime);
	} else {
		routine = {
			id: nanoid(),
			name,
			prompt,
			triggers: [resolvedTrigger],
			context: "session",
			quiet: quiet ?? false,
			...(maxTicks !== undefined ? { maxTicks } : {}),
			createdAt: Date.now(),
		};
		runtime.store.tickState[routine.id] = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};
	}

	runtime.store.routines[routine.id] = routine;
	await saveStore(runtime.store);

	scheduleRoutine(routine, runtime, pi, getCtx);

	const primary = routine.triggers[0];
	const result: CreateRoutineSuccess = {
		id: routine.id,
		name: routine.name,
		triggerDescription: describeTriggers(routine.triggers),
		updated: Boolean(existing),
	};
	if (primary && primary.kind === "pulse") {
		result.nextFireIn = primary.intervalHuman;
	}
	return result;
}

/**
 * Delete a routine by id or (case-insensitive) name. Unschedules any pulse
 * timer and persists the store.
 */
export async function deleteRoutine(
	idOrName: string,
	runtime: RoutineRuntimeState,
): Promise<DeleteRoutineResult> {
	if (!idOrName) {
		return { error: "Provide a routine id or name." };
	}
	const routine = resolveRoutine(idOrName, runtime);
	if (!routine) {
		return {
			error: `No routine matched '${idOrName}'. Current routines: ${listRoutineNames(runtime)}.`,
		};
	}
	unscheduleRoutine(routine.id, runtime);
	delete runtime.store.routines[routine.id];
	delete runtime.store.tickState[routine.id];
	await saveStore(runtime.store);
	return { deletedId: routine.id, deletedName: routine.name };
}
