/**
 * @file executor.ts — builds a routine's prompt and fires it.
 *
 * Owns:
 *   - {@link buildPrompt}: pure prompt assembly (prefix + placeholder substitution
 *     + optional quiet-mode `[~]` footer).
 *   - {@link fireRoutine}: side-effectful single-shot firing (maxTicks gate,
 *     guard acquisition, `pi.sendUserMessage`, tickState write-through, error
 *     recovery).
 *
 * Does NOT own:
 *   - Scheduling / queueing — that belongs to `scheduler.ts`.
 *   - Lifecycle event subscriptions — that belongs to `hooks.ts` (TP-006).
 *   - Suppression of `[~]` output in chat — that belongs to TP-003.
 *
 * Recursion guard is acquired here but is released by the caller of the
 * subsequent agent_end event (see `hooks.ts` in TP-006). On exception during
 * firing, the guard is released here so the routine survives.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import * as guard from "./guard.ts";
import { unscheduleRoutine } from "./scheduler.ts";
import { saveStore } from "./store.ts";
import type {
	Routine,
	RoutineRun,
	RoutineRuntimeState,
	RoutineStore,
	RoutineTickState,
	RoutineTrigger,
} from "./types.ts";
import { MAX_RUN_HISTORY, MAX_USER_STATE_BYTES } from "./types.ts";

/** Build the full prompt string that will be injected into the session. */
export function buildPrompt(
	routine: Routine,
	tickState: RoutineTickState,
	cwd: string,
	apiArgs?: Record<string, unknown> | null,
	githubEvent?: Record<string, unknown> | null,
): string {
	const now = new Date();
	const time = now.toLocaleTimeString();
	const date = now.toLocaleDateString();
	const hhmm = time.replace(/:\d{2}(?:\s?[AP]M)?$/i, (m) => {
		// Convert "14:23:45" → "14:23"; preserve am/pm if present.
		const ampm = /[AP]M/i.exec(m)?.[0] ?? "";
		return ampm ? ` ${ampm}` : "";
	});
	const nextTick = tickState.tickCount + 1;

	// userState injection with size cap.
	let userStateJson = JSON.stringify(tickState.userState ?? {});
	let truncated = false;
	if (userStateJson.length > MAX_USER_STATE_BYTES) {
		userStateJson = "{}";
		truncated = true;
	}

	// Substitute placeholders inside the user-authored prompt body.
	const substituted = routine.prompt
		.replaceAll("{cwd}", cwd)
		.replaceAll("{date}", date)
		.replaceAll("{time}", time)
		.replaceAll("{state}", userStateJson)
		.replaceAll("{tickCount}", String(nextTick))
		.replaceAll("{apiArgs}", apiArgs ? JSON.stringify(apiArgs) : "{}")
		.replaceAll("{githubEvent}", githubEvent ? JSON.stringify(githubEvent) : "{}");

	const header =
		`[↺ routine: ${routine.name} · tick ${nextTick} · ${hhmm}]\n` +
		`Previous state: ${userStateJson}\n\n` +
		substituted;

	const truncNote = truncated ? "\n\n[state truncated]" : "";

	const quietFooter = routine.quiet
		? "\n\n---\n" +
			"If nothing changed and there is nothing to report, respond with exactly: [~]\n" +
			"Do not explain that you are responding with [~]. Just output [~] and nothing else."
		: "";

	return header + truncNote + quietFooter;
}

/**
 * Fire a single routine: gate on maxTicks + maxRunsPerDay, build prompt,
 * acquire guard, send message, update tickState (write-through). On
 * exception, release guard and log — the routine survives. The guard is
 * released by `hooks.ts` on the subsequent `agent_end` in the happy path.
 */
export async function fireRoutine(
	routine: Routine,
	runtime: RoutineRuntimeState,
	store: RoutineStore,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const existing: RoutineTickState | undefined = store.tickState[routine.id];
	const tickState: RoutineTickState = existing ?? {
		tickCount: 0,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
	};

	// maxTicks gate — applied BEFORE acquiring the guard so an exhausted
	// routine cleans itself up without occupying a turn.
	if (typeof routine.maxTicks === "number" && tickState.tickCount >= routine.maxTicks) {
		unscheduleRoutine(routine.id, runtime);
		delete store.routines[routine.id];
		delete store.tickState[routine.id];
		await saveStore(store);
		return;
	}

	// Pull (and consume) trigger origin set by scheduler / hook / manual-fire
	// path. Default: first trigger.
	const origin = runtime.triggerOrigin.get(routine.id) ?? {
		index: 0,
		kind: (routine.triggers[0]?.kind ?? "pulse") as RoutineTrigger["kind"] | "manual",
	};
	runtime.triggerOrigin.delete(routine.id);

	const startedAt = Date.now();

	// maxRunsPerDay soft cap — applied BEFORE acquiring the guard so capped
	// fires consume zero provider tokens. The counter rolls over to 0 at
	// local midnight (compared via the `en-CA` locale's ISO date format).
	// Manual fires (/routine-run-now) bypass this cap, matching pause
	// semantics; the user explicitly asked for an extra run.
	if (typeof routine.maxRunsPerDay === "number" && origin.kind !== "manual") {
		const today = new Date().toLocaleDateString("en-CA");
		const sameDay = tickState.runsTodayDate === today;
		const usedToday = sameDay ? (tickState.runsToday ?? 0) : 0;
		if (usedToday >= routine.maxRunsPerDay) {
			recordRun(runtime, store, {
				id: nanoid(),
				routineId: routine.id,
				startedAt,
				endedAt: startedAt,
				durationMs: 0,
				status: "skipped",
				triggerIndex: origin.index,
				triggerKind: origin.kind,
				snippet: `Daily cap reached (${usedToday}/${routine.maxRunsPerDay})`,
				skipReason: "daily cap reached",
			});
			return;
		}
	}

	try {
		guard.acquireRoutineTurn(runtime, routine.name);

		// Open the run record. The suppressor / message_end handler will
		// populate `snippet` + downgrade to `"silent"` if the response is `[~]`.
		// `agent_end` finalises it.
		runtime.pendingRun = {
			routineId: routine.id,
			runId: nanoid(),
			triggerIndex: origin.index,
			triggerKind: origin.kind,
			startedAt,
			snippet: "",
			status: "success",
		};

		const apiArgs = runtime.apiArgs?.get(routine.id) ?? null;
		runtime.apiArgs?.delete(routine.id);
		const githubEvent = runtime.githubEvents?.get(routine.id) ?? null;
		runtime.githubEvents?.delete(routine.id);
		const prompt = buildPrompt(routine, tickState, ctx.cwd, apiArgs, githubEvent);

		// NB: PLAN/PROMPT request `deliverAs: "nextTurn"`, but the typed
		// ExtensionAPI.sendUserMessage signature only allows "steer" | "followUp".
		// "followUp" is the closest equivalent (queue after the current turn
		// without interrupting). See Discoveries.
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });

		const today = new Date().toLocaleDateString("en-CA");
		const sameDay = tickState.runsTodayDate === today;
		const updated: RoutineTickState = {
			tickCount: tickState.tickCount + 1,
			lastFiredAt: Date.now(),
			lastFiredDateLocal: today,
			userState: tickState.userState ?? {},
			runs: tickState.runs ?? [],
			runsToday: (sameDay ? (tickState.runsToday ?? 0) : 0) + 1,
			runsTodayDate: today,
		};
		store.tickState[routine.id] = updated;
		await saveStore(store);
	} catch (err) {
		guard.releaseRoutineTurn(runtime);
		// Record the failed run synchronously — agent_end will not fire for
		// a turn that never started.
		recordRun(runtime, store, {
			id: nanoid(),
			routineId: routine.id,
			startedAt,
			endedAt: Date.now(),
			durationMs: Date.now() - startedAt,
			status: "error",
			triggerIndex: origin.index,
			triggerKind: origin.kind,
			snippet: truncateSnippet(err instanceof Error ? err.message : String(err)),
		});
		runtime.pendingRun = null;
		console.error(`[pi-routines] fireRoutine '${routine.name}' (${routine.id}) failed:`, err);
	}
}

/**
 * Push a {@link RoutineRun} into the routine's `tickState.runs` ring buffer,
 * trimming to {@link MAX_RUN_HISTORY}, then persist. Caller must already have
 * a `tickState` entry for the routine (created by `fireRoutine`).
 */
export function recordRun(
	runtime: RoutineRuntimeState,
	store: RoutineStore,
	run: RoutineRun,
): void {
	const ts = store.tickState[run.routineId];
	if (!ts) return;
	const runs = ts.runs ?? [];
	runs.push(run);
	while (runs.length > MAX_RUN_HISTORY) runs.shift();
	ts.runs = runs;
	// Fire-and-forget save — saveStore is best-effort and never throws.
	void saveStore(store);
	void runtime; // reserved for future debounce hook
}

/** Truncate a candidate snippet to {@link SNIPPET_MAX_CHARS}. */
export function truncateSnippet(text: string): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 199)}…`;
}
