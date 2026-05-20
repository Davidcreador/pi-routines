/**
 * @file scheduler.ts — owns pulse-routine timers and the fire queue.
 *
 * Owns:
 *   - `setInterval` handles, one per pulse routine, stored in `runtime.timers`.
 *   - The FIFO fire queue (`runtime.queue`), with dedup + backpressure cap.
 *   - The idle-aware `drainQueue` loop that hands work to `executor.fireRoutine`.
 *
 * Does NOT own:
 *   - `pi.on(...)` subscriptions — `hooks.ts` (TP-006) listens for `agent_end`
 *     etc. and calls into `drainQueue` / `startScheduler` / etc.
 *   - Prompt building or message sending — that is `executor.ts`.
 *   - Hook-trigger ("once: daily/per_session") logic — that is `guard.ts`.
 *
 * Stale-context defence: a `getCtx()` returning null OR throwing the
 * "Extension context no longer active" error permanently halts the offending
 * timer (the runtime is being torn down anyway).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fireRoutine } from "./executor.ts";
import * as guard from "./guard.ts";
import type { Routine, RoutineRuntimeState } from "./types.ts";
import { MAX_QUEUE_DEPTH } from "./types.ts";

const STALE_CTX_MARKER = "Extension context no longer active";

/** True if the error/ctx indicates the extension runtime is gone. */
function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes(STALE_CTX_MARKER);
}

/** Start intervals for every pulse routine currently in the store. */
export function startScheduler(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	for (const routine of Object.values(runtime.store.routines)) {
		if (routine.trigger.kind === "pulse") {
			scheduleRoutine(routine, runtime, pi, getCtx);
		}
	}
}

/** Clear every active timer and empty the queue. Leaves store untouched. */
export function stopScheduler(runtime: RoutineRuntimeState): void {
	for (const handle of runtime.timers.values()) {
		clearInterval(handle);
	}
	runtime.timers.clear();
	runtime.queue.length = 0;
}

/**
 * Start (or restart) the interval for a single pulse routine. Idempotent:
 * any existing timer for this id is cleared first.
 */
export function scheduleRoutine(
	routine: Routine,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	if (routine.trigger.kind !== "pulse") return;

	const existing = runtime.timers.get(routine.id);
	if (existing) clearInterval(existing);

	const handle = setInterval(() => {
		try {
			// Routine deleted out from under us → clear timer, done.
			if (!runtime.store.routines[routine.id]) {
				const h = runtime.timers.get(routine.id);
				if (h) clearInterval(h);
				runtime.timers.delete(routine.id);
				return;
			}

			// Dedup: same routine already queued → skip.
			if (runtime.queue.includes(routine.id)) return;

			// Backpressure: drop the OLDEST entry for this routine before push.
			if (runtime.queue.length >= MAX_QUEUE_DEPTH) {
				const oldestIdx = runtime.queue.findIndex((id) => id === routine.id);
				if (oldestIdx >= 0) {
					runtime.queue.splice(oldestIdx, 1);
				} else {
					// Cap reached but none of our id present → drop oldest
					// queue entry to make room.
					runtime.queue.shift();
				}
			}

			runtime.queue.push(routine.id);
			void drainQueue(runtime, pi, getCtx);
		} catch (err) {
			if (isStaleCtxError(err)) {
				const h = runtime.timers.get(routine.id);
				if (h) clearInterval(h);
				runtime.timers.delete(routine.id);
				console.warn(
					`[pi-routines] scheduler: stale ctx, stopping timer '${routine.name}'`,
				);
				return;
			}
			console.error(
				`[pi-routines] scheduler tick '${routine.name}' failed:`,
				err,
			);
		}
	}, routine.trigger.intervalMs);

	runtime.timers.set(routine.id, handle);
}

/** Clear the interval for a single routine. Safe to call if none exists. */
export function unscheduleRoutine(
	routineId: string,
	runtime: RoutineRuntimeState,
): void {
	const handle = runtime.timers.get(routineId);
	if (handle) clearInterval(handle);
	runtime.timers.delete(routineId);
}

/**
 * Drain queued routine ids while the session is idle. Stops at the first
 * not-idle indicator (busy ctx, pending messages, in-flight routine turn).
 */
export async function drainQueue(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): Promise<void> {
	while (runtime.queue.length > 0) {
		let ctx: ExtensionContext | null;
		try {
			ctx = getCtx();
		} catch (err) {
			if (isStaleCtxError(err)) {
				console.warn(
					`[pi-routines] drainQueue: stale ctx; stopping all timers`,
				);
				stopScheduler(runtime);
				return;
			}
			throw err;
		}
		if (!ctx) return;
		if (guard.isRoutineTurnActive(runtime)) return;
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;

		const id = runtime.queue.shift();
		if (!id) return;
		const routine = runtime.store.routines[id];
		if (!routine) continue; // deleted while queued — skip silently

		runtime.lastUiCtx = ctx;
		await fireRoutine(routine, runtime, runtime.store, pi, ctx);
	}
}
