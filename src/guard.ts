/**
 * @file guard.ts — recursion-prevention primitives for routine firing.
 *
 * Routines that respond to lifecycle events (notably `agent_end`) can form
 * feedback loops: a routine fires → sends a message → agent_end fires →
 * routine fires again. This module provides the pure helpers that
 * `hooks.ts` / `executor.ts` (downstream tasks) wire together to make a
 * three-level guard:
 *
 *   1. **Flag guard** — {@link acquireRoutineTurn} / {@link releaseRoutineTurn}
 *      / {@link isRoutineTurnActive} flip a single boolean on the runtime
 *      state. Hook handlers MUST consult {@link isRoutineTurnActive} and skip
 *      when it's true.
 *   2. **Input-source tagging** — `hooks.ts` tags `input` events whose source
 *      is `"extension"` while the flag is set, so subsequent `agent_end`
 *      handlers can recognize "this turn was our own routine" and not
 *      re-trigger.
 *   3. **Depth check** — {@link acquireRoutineTurn} throws if the flag is
 *      already true, surfacing programmer errors. A well-behaved sequential
 *      queue never trips this.
 *
 * This module owns NO event subscriptions and performs no I/O.
 */

import type {
	Routine,
	RoutineRuntimeState,
	RoutineTickState,
} from "./types.ts";

/**
 * Mark the runtime as actively executing a routine turn.
 *
 * @throws Error if a routine turn is already active. The scheduler queue is
 * sequential by construction, so this should never fire in normal operation;
 * a throw indicates a bug in the executor or a missed release.
 */
export function acquireRoutineTurn(
	runtime: RoutineRuntimeState,
	routineName: string,
): void {
	if (runtime.isRoutineTurnActive) {
		throw new Error(
			`acquireRoutineTurn: turn already active for '${runtime.activeRoutineName ?? "?"}'`,
		);
	}
	runtime.isRoutineTurnActive = true;
	runtime.activeRoutineName = routineName;
}

/**
 * Release a previously-acquired routine turn. Idempotent: safe to call from
 * a `finally` block even if the turn was never acquired.
 */
export function releaseRoutineTurn(runtime: RoutineRuntimeState): void {
	runtime.isRoutineTurnActive = false;
	runtime.activeRoutineName = null;
}

/** True if a routine turn is currently in flight. */
export function isRoutineTurnActive(runtime: RoutineRuntimeState): boolean {
	return runtime.isRoutineTurnActive;
}

/**
 * Decide whether a hook routine should fire on the current event.
 *
 * Implements the {@link Routine.trigger.once} semantics:
 *   - `"daily"`       — fire at most once per local calendar day. Compares
 *                       today's `YYYY-MM-DD` (via `toLocaleDateString("en-CA")`,
 *                       which produces ISO-formatted local dates) against the
 *                       stored `lastFiredDateLocal`.
 *   - `"per_session"` — fire at most once per pi session. Detected by the
 *                       absence of `tickState` (which is reset on session_start).
 *   - undefined       — always fire.
 *
 * Pulse routines should not call this — they're driven by setInterval.
 *
 * @param routine   The routine being considered.
 * @param tickState The persisted tick state for this routine, or `undefined`
 *                  if it has never fired (or was reset on session_start).
 */
export function shouldFireHook(
	routine: Routine,
	tickState: RoutineTickState | undefined,
): boolean {
	if (routine.trigger.kind !== "hook") return false;
	const once = routine.trigger.once;
	if (!once) return true;
	if (!tickState) return true;

	if (once === "per_session") {
		return tickState.tickCount === 0;
	}
	if (once === "daily") {
		const today = new Date().toLocaleDateString("en-CA");
		return tickState.lastFiredDateLocal !== today;
	}
	return true;
}
