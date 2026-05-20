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

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as guard from "./guard.ts";
import { saveStore } from "./store.ts";
import { unscheduleRoutine } from "./scheduler.ts";
import type {
	Routine,
	RoutineRuntimeState,
	RoutineStore,
	RoutineTickState,
} from "./types.ts";
import { MAX_USER_STATE_BYTES } from "./types.ts";

/** Build the full prompt string that will be injected into the session. */
export function buildPrompt(
	routine: Routine,
	tickState: RoutineTickState,
	cwd: string,
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
		.replaceAll("{tickCount}", String(nextTick));

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
 * Fire a single routine: gate on maxTicks, build prompt, acquire guard, send
 * message, update tickState (write-through). On exception, release guard and
 * log — the routine survives. The guard is released by `hooks.ts` on the
 * subsequent `agent_end` in the happy path.
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
	if (
		typeof routine.maxTicks === "number" &&
		tickState.tickCount >= routine.maxTicks
	) {
		unscheduleRoutine(routine.id, runtime);
		delete store.routines[routine.id];
		delete store.tickState[routine.id];
		await saveStore(store);
		return;
	}

	try {
		guard.acquireRoutineTurn(runtime, routine.name);

		const prompt = buildPrompt(routine, tickState, ctx.cwd);

		// NB: PLAN/PROMPT request `deliverAs: "nextTurn"`, but the typed
		// ExtensionAPI.sendUserMessage signature only allows "steer" | "followUp".
		// "followUp" is the closest equivalent (queue after the current turn
		// without interrupting). See Discoveries.
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });

		const updated: RoutineTickState = {
			tickCount: tickState.tickCount + 1,
			lastFiredAt: Date.now(),
			lastFiredDateLocal: new Date().toLocaleDateString("en-CA"),
			userState: tickState.userState ?? {},
		};
		store.tickState[routine.id] = updated;
		await saveStore(store);
	} catch (err) {
		guard.releaseRoutineTurn(runtime);
		console.error(
			`[pi-routines] fireRoutine '${routine.name}' (${routine.id}) failed:`,
			err,
		);
	}
}
