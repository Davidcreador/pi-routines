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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fireRoutine } from "./executor.ts";
import * as guard from "./guard.ts";
import { nextCronFire, parseOneOff } from "./parser.ts";
import type { Routine, RoutineRuntimeState, RoutineTrigger } from "./types.ts";
import { MAX_QUEUE_DEPTH, MULTI_TRIGGER_COLLAPSE_MS } from "./types.ts";

const STALE_CTX_MARKER = "Extension context no longer active";

/** True if the error/ctx indicates the extension runtime is gone. */
function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes(STALE_CTX_MARKER);
}

/** Start timers for every routine currently in the store. */
export function startScheduler(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	for (const routine of Object.values(runtime.store.routines)) {
		scheduleRoutine(routine, runtime, pi, getCtx);
	}
}

/** Map of routineId → epoch ms of last enqueue, for multi-trigger dedup. */
const lastEnqueueAt = new WeakMap<RoutineRuntimeState, Map<string, number>>();

function getEnqueueMap(runtime: RoutineRuntimeState): Map<string, number> {
	let m = lastEnqueueAt.get(runtime);
	if (!m) {
		m = new Map();
		lastEnqueueAt.set(runtime, m);
	}
	return m;
}

/** Clear every active timer and empty the queue. Leaves store untouched. */
export function stopScheduler(runtime: RoutineRuntimeState): void {
	for (const handles of runtime.timers.values()) {
		for (const h of handles) {
			if (h) clearTimeout(h as unknown as NodeJS.Timeout);
		}
	}
	runtime.timers.clear();
	runtime.queue.length = 0;
	getEnqueueMap(runtime).clear();
}

/**
 * Start (or restart) all time-based triggers for a single routine. Idempotent:
 * any existing timers for this id are cleared first. Hook triggers are
 * skipped — they are armed via `pi.on(...)` subscriptions in `hooks.ts`.
 */
export function scheduleRoutine(
	routine: Routine,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	unscheduleRoutine(routine.id, runtime);

	const handles: Array<ReturnType<typeof setInterval> | null> = [];
	routine.triggers.forEach((trigger, idx) => {
		const h = armTrigger(routine, idx, trigger, runtime, pi, getCtx);
		handles.push(h);
	});
	if (handles.some((h) => h !== null)) {
		runtime.timers.set(routine.id, handles);
	}
}

function armTrigger(
	routine: Routine,
	triggerIndex: number,
	trigger: RoutineTrigger,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): ReturnType<typeof setInterval> | null {
	const onFire = () => onTriggerFire(routine, triggerIndex, runtime, pi, getCtx);

	switch (trigger.kind) {
		case "pulse":
			return setInterval(onFire, trigger.intervalMs);
		case "cron": {
			const arm = () => {
				try {
					const next = nextCronFire(trigger.expr, trigger.timezone, new Date());
					const delay = Math.max(0, next.getTime() - Date.now());
					const h = setTimeout(() => {
						onFire();
						// Re-arm only if routine is still active.
						if (runtime.store.routines[routine.id]) arm();
					}, delay);
					const arr = runtime.timers.get(routine.id);
					if (arr) arr[triggerIndex] = h as unknown as ReturnType<typeof setInterval>;
				} catch (err) {
					console.error(
						`[pi-routines] cron arm failed for '${routine.name}' [${trigger.expr}]:`,
						err,
					);
				}
			};
			try {
				const next = nextCronFire(trigger.expr, trigger.timezone, new Date());
				const delay = Math.max(0, next.getTime() - Date.now());
				return setTimeout(() => {
					onFire();
					if (runtime.store.routines[routine.id]) arm();
				}, delay) as unknown as ReturnType<typeof setInterval>;
			} catch (err) {
				console.error(`[pi-routines] cron parse failed for '${routine.name}':`, err);
				return null;
			}
		}
		case "oneoff": {
			try {
				const at = parseOneOff(trigger.fireAtIso, trigger.timezone);
				const delay = Math.max(0, at.getTime() - Date.now());
				return setTimeout(() => {
					onFire();
					// One-off self-clears its slot.
					const arr = runtime.timers.get(routine.id);
					if (arr) arr[triggerIndex] = null;
				}, delay) as unknown as ReturnType<typeof setInterval>;
			} catch (err) {
				console.error(`[pi-routines] one-off arm failed for '${routine.name}':`, err);
				return null;
			}
		}
		case "hook":
			return null; // armed by hooks.ts
		case "api":
			return null; // armed by the HTTP server (src/server.ts)
	}
}

function onTriggerFire(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	try {
		if (!runtime.store.routines[routine.id]) {
			unscheduleRoutine(routine.id, runtime);
			return;
		}

		// Multi-trigger collapse: distinct triggers within COLLAPSE_MS share one enqueue.
		const now = Date.now();
		const enq = getEnqueueMap(runtime);
		const last = enq.get(routine.id) ?? 0;
		if (now - last < MULTI_TRIGGER_COLLAPSE_MS) return;
		enq.set(routine.id, now);

		// Dedup vs already-queued.
		if (runtime.queue.includes(routine.id)) return;

		// Backpressure.
		if (runtime.queue.length >= MAX_QUEUE_DEPTH) {
			const oldestIdx = runtime.queue.indexOf(routine.id);
			if (oldestIdx >= 0) runtime.queue.splice(oldestIdx, 1);
			else runtime.queue.shift();
		}

		// Record trigger origin so fireRoutine can attribute the run record.
		const trigger = routine.triggers[triggerIndex];
		if (trigger) {
			runtime.triggerOrigin.set(routine.id, { index: triggerIndex, kind: trigger.kind });
		}

		runtime.queue.push(routine.id);
		void drainQueue(runtime, pi, getCtx);
	} catch (err) {
		if (isStaleCtxError(err)) {
			unscheduleRoutine(routine.id, runtime);
			console.warn(`[pi-routines] scheduler: stale ctx, stopping '${routine.name}'`);
			return;
		}
		console.error(`[pi-routines] scheduler tick '${routine.name}' failed:`, err);
	}
}

/** Clear all timers for a single routine. Safe to call if none exist. */
export function unscheduleRoutine(routineId: string, runtime: RoutineRuntimeState): void {
	const handles = runtime.timers.get(routineId);
	if (handles) {
		for (const h of handles) {
			if (h) {
				clearTimeout(h as unknown as NodeJS.Timeout);
				clearInterval(h);
			}
		}
	}
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
				console.warn(`[pi-routines] drainQueue: stale ctx; stopping all timers`);
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
