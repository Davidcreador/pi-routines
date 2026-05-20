/**
 * @file routine-create.ts — LLM-callable `RoutineCreate` tool.
 *
 * Registers a recurring (pulse) or event-driven (hook) routine. Validates
 * name, interval, agent_end uniqueness and the global 20-routine cap.
 * Upserts by name — calling with an existing name updates the routine
 * (preserving `id`, `createdAt`, `tickState`).
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { nanoid } from "nanoid";
import { Type, type Static } from "typebox";
import { parseInterval } from "../parser.ts";
import { scheduleRoutine, unscheduleRoutine } from "../scheduler.ts";
import { saveStore } from "../store.ts";
import type {
	HookEvent,
	Routine,
	RoutineRuntimeState,
	RoutineTrigger,
} from "../types.ts";

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const MAX_ROUTINES = 20;

const ParamsSchema = Type.Object({
	name: Type.String({
		description:
			"Short identifier, lowercase letters/digits/hyphens, max 32 chars.",
	}),
	prompt: Type.String({
		description:
			"What to ask Pi on each tick. For quiet routines, end with instructions to output [~] if nothing changed.",
	}),
	trigger: Type.Union([
		Type.Object({
			kind: Type.Literal("pulse"),
			interval: Type.String({
				description: "Interval like '5m', '1h', '30s', '1h30m'.",
			}),
		}),
		Type.Object({
			kind: Type.Literal("hook"),
			event: Type.Union([
				Type.Literal("session_start"),
				Type.Literal("agent_end"),
				Type.Literal("session_shutdown"),
			]),
			once: Type.Optional(
				Type.Union([Type.Literal("daily"), Type.Literal("per_session")]),
			),
		}),
	]),
	quiet: Type.Optional(
		Type.Boolean({
			description:
				"Suppress [~] responses from chat (show only in footer). Default: false.",
		}),
	),
	maxTicks: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Auto-delete after N fires. Omit for unlimited.",
		}),
	),
});

type Params = Static<typeof ParamsSchema>;

interface Details {
	id: string;
	name: string;
	triggerDescription: string;
	nextFireIn?: string;
}

function errorResult(message: string): AgentToolResult<Details | null> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: null,
	};
}

function describeTrigger(t: RoutineTrigger): string {
	if (t.kind === "pulse") return `every ${t.intervalHuman}`;
	return t.once ? `on ${t.event} (${t.once})` : `on ${t.event}`;
}

/**
 * Register the `RoutineCreate` tool.
 *
 * The LLM calls this to schedule a new pulse or hook routine. Use it when
 * the user asks Pi to "check every N minutes", "run on session start",
 * or otherwise wants Pi to act autonomously on a schedule or event.
 */
export function registerRoutineCreateTool(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerTool({
		name: "RoutineCreate",
		label: "Routine: Create",
		description:
			"Create or update a recurring (pulse) or event-driven (hook) routine. " +
			"Pulse routines fire on an interval (e.g. every 5m). Hook routines fire " +
			"on session lifecycle events (session_start, agent_end, session_shutdown). " +
			"Call with an existing name to update the routine in place.",
		parameters: ParamsSchema,

		async execute(
			_id,
			params: Params,
		): Promise<AgentToolResult<Details | null>> {
			const { name, prompt, trigger, quiet, maxTicks } = params;

			// 1. Name validation.
			if (!NAME_RE.test(name)) {
				return errorResult(
					`Invalid name '${name}'. Use lowercase letters, digits, and hyphens (max 32 chars).`,
				);
			}

			// 2. Resolve trigger; for pulse parse interval (may throw).
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
					return errorResult((err as Error).message);
				}
			} else {
				resolvedTrigger = {
					kind: "hook",
					event: trigger.event as HookEvent,
					...(trigger.once ? { once: trigger.once } : {}),
				};
			}

			// 3. Look up existing by name (case-sensitive — name regex is lowercase).
			const existing = Object.values(runtime.store.routines).find(
				(r) => r.name === name,
			);

			// 4. agent_end hook uniqueness check (excluding the one being updated).
			if (
				resolvedTrigger.kind === "hook" &&
				resolvedTrigger.event === "agent_end"
			) {
				const conflict = Object.values(runtime.store.routines).find(
					(r) =>
						r.trigger.kind === "hook" &&
						r.trigger.event === "agent_end" &&
						r.id !== existing?.id,
				);
				if (conflict) {
					return errorResult(
						`Another routine ('${conflict.name}') already uses the agent_end hook. ` +
							"Delete it first or pick a different event.",
					);
				}
			}

			// 5. Global cap (only when creating new).
			if (
				!existing &&
				Object.keys(runtime.store.routines).length >= MAX_ROUTINES
			) {
				return errorResult(
					`Routine limit reached (${MAX_ROUTINES}). Delete an existing routine first.`,
				);
			}

			// 6. Build or update routine.
			let routine: Routine;
			if (existing) {
				// Update in place; preserve id/createdAt/tickState.
				routine = {
					...existing,
					prompt,
					trigger: resolvedTrigger,
					quiet: quiet ?? existing.quiet ?? false,
					...(maxTicks !== undefined
						? { maxTicks }
						: { maxTicks: existing.maxTicks }),
				};
				// If the pulse interval changed (or trigger kind changed), clear the
				// old timer; we re-schedule below.
				const old = existing.trigger;
				const intervalChanged =
					old.kind !== resolvedTrigger.kind ||
					(old.kind === "pulse" &&
						resolvedTrigger.kind === "pulse" &&
						old.intervalMs !== resolvedTrigger.intervalMs);
				if (intervalChanged) {
					unscheduleRoutine(existing.id, runtime);
				}
			} else {
				routine = {
					id: nanoid(),
					name,
					prompt,
					trigger: resolvedTrigger,
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

			if (routine.trigger.kind === "pulse") {
				scheduleRoutine(routine, runtime, pi, getCtx);
			}

			const triggerDescription = describeTrigger(routine.trigger);
			const details: Details = {
				id: routine.id,
				name: routine.name,
				triggerDescription,
			};
			if (routine.trigger.kind === "pulse") {
				details.nextFireIn = routine.trigger.intervalHuman;
			}

			const verb = existing ? "Updated" : "Created";
			const msg =
				routine.trigger.kind === "pulse"
					? `${verb} pulse routine '${routine.name}' — fires ${triggerDescription}. Next fire in ~${routine.trigger.intervalHuman}.`
					: `${verb} hook routine '${routine.name}' — fires ${triggerDescription}.`;

			return {
				content: [{ type: "text", text: msg }],
				details,
			};
		},

		renderCall(args) {
			const t = args.trigger;
			const trig = t.kind === "pulse" ? `every ${t.interval}` : `on ${t.event}`;
			return new Text(`RoutineCreate ${args.name} — ${trig}`, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}
