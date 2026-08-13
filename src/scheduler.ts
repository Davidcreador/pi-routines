/**
 * @file scheduler.ts — owns pulse-routine timers and the fire queue.
 *
 * Owns:
 *   - `setInterval` handles, one per pulse routine, stored in `runtime.timers`.
 *   - The FIFO fire queue (`runtime.queue`), with dedup + backpressure cap.
 *   - Queue persistence: `runtime.queue` is mirrored into
 *     `store.pendingQueue` on every mutation and re-enqueued by
 *     {@link rehydrateQueuedFires} at the next interactive `session_start`,
 *     so session teardown no longer loses queued fires.
 *   - The idle-aware `drainQueue` loop that hands work to `executor.fireRoutine`.
 *   - The drain watchdog (`runtime.drainWatchdog`), an idle-watch retry timer
 *     armed iff the fire queue is non-empty, so queued fires cannot starve
 *     while the session stays busy across every drain trigger.
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
import { nanoid } from "nanoid";
import { fireRoutine, recordSkippedFire } from "./executor.ts";
import { armGithubPoller } from "./github-poller.ts";
import * as guard from "./guard.ts";
import { nextCronFire, parseOneOff } from "./parser.ts";
import { saveStore } from "./store.ts";
import type { Routine, RoutineQueueEntry, RoutineRuntimeState, RoutineTrigger } from "./types.ts";
import { MAX_QUEUE_DEPTH, MAX_QUEUED_FIRE_AGE_MS, MULTI_TRIGGER_COLLAPSE_MS } from "./types.ts";

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

/**
 * Clear every active timer and the in-memory fire queue. Queued fires are
 * NOT dropped: `store.pendingQueue` still mirrors them (see
 * {@link persistQueue}), so the next interactive session re-enqueues them
 * via {@link rehydrateQueuedFires}. Teardown therefore records no per-entry
 * skip — nothing was lost — unlike the deferred-hook drops, which remain
 * audited at their own expiry.
 */
export function stopScheduler(runtime: RoutineRuntimeState, reason?: string): void {
	for (const handles of runtime.timers.values()) {
		for (const h of handles) {
			if (h) clearTimeout(h as unknown as NodeJS.Timeout);
		}
	}
	runtime.timers.clear();
	disarmDrainWatchdog(runtime);
	if (reason && runtime.queue.length > 0) {
		console.warn(
			`[pi-routines] scheduler stopped (${reason}); ${runtime.queue.length} queued fire(s) persist for the next session`,
		);
	}
	runtime.queue.length = 0;
	getEnqueueMap(runtime).clear();
}

/**
 * Mirror the in-memory fire queue into `store.pendingQueue` and persist.
 * Called after EVERY queue mutation (enqueue, overflow drop, drain shift)
 * so a crash or quit at any point leaves the store at most one mutation
 * behind. Deferred-hook entries are excluded: their backing records already
 * persist in `store.deferredHooks` and re-enqueue via `promoteDeferredHooks`.
 * Returns the saveStore promise so drainQueue can await durability before
 * opening a turn (at-least-once across crashes, never phantom-double-fire
 * from a torn write).
 */
export function persistQueue(runtime: RoutineRuntimeState): Promise<void> {
	runtime.store.pendingQueue = runtime.queue.filter((entry) => !entry.deferredHookId);
	return saveStore(runtime.store, runtime.storeGeneration);
}

export function queueEntryRoutineId(entry: RoutineQueueEntry): string {
	return entry.routineId;
}

export function queueHasRoutine(runtime: RoutineRuntimeState, routineId: string): boolean {
	return runtime.queue.some((entry) => queueEntryRoutineId(entry) === routineId);
}

function dropQueuedFireAt(runtime: RoutineRuntimeState, index: number, reason: string): void {
	const [dropped] = runtime.queue.splice(index, 1);
	if (!dropped) return;
	void persistQueue(runtime);
	const routine = runtime.store.routines[dropped.routineId];
	if (!routine) return;
	recordSkippedFire(runtime, runtime.store, routine, dropped.origin, reason, dropped.runId);
}

export interface QueueMetadata {
	runId?: string;
	/** Original enqueue time, preserved by rehydration; defaults to now. */
	queuedAt?: number;
	apiArgs?: Record<string, unknown>;
	githubEvent?: Record<string, unknown>;
	contextNote?: string;
	hookOnceKey?: string;
	hookOnce?: RoutineQueueEntry["hookOnce"];
	deferredHookId?: string;
	autoDrain?: boolean;
	priority?: boolean;
}

/** Enqueue one fully-described fire, applying shared backpressure and drain handling. */
export function enqueueRoutineFire(
	routine: Routine,
	origin: RoutineQueueEntry["origin"],
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
	metadata: QueueMetadata = {},
): string {
	const { autoDrain = true, priority = false, runId = nanoid(), ...entryMetadata } = metadata;
	if (runtime.queue.length >= MAX_QUEUE_DEPTH) {
		let normalIndex = -1;
		if (priority) {
			for (let index = runtime.queue.length - 1; index >= 0; index--) {
				if (!runtime.queue[index]?.deferredHookId) {
					normalIndex = index;
					break;
				}
			}
		}
		dropQueuedFireAt(runtime, normalIndex >= 0 ? normalIndex : 0, "queue overflow");
	}
	const entry: RoutineQueueEntry = {
		routineId: routine.id,
		runId,
		origin,
		...entryMetadata,
		// After the spread so an explicit `queuedAt: undefined` in metadata
		// cannot blank the computed default.
		queuedAt: entryMetadata.queuedAt ?? Date.now(),
	};
	if (priority) {
		const firstNormal = runtime.queue.findIndex((queued) => !queued.deferredHookId);
		runtime.queue.splice(firstNormal >= 0 ? firstNormal : runtime.queue.length, 0, entry);
	} else {
		runtime.queue.push(entry);
	}
	void persistQueue(runtime);
	reconcileDrainWatchdog(runtime, pi, getCtx);
	if (autoDrain) {
		void drainQueue(runtime, pi, getCtx).catch((err) => {
			console.error(`[pi-routines] queue drain failed for '${routine.name}':`, err);
		});
	}
	return runId;
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
			// Spent — silently skip. The post-fire callback below sets this.
			if (trigger.fired) return null;
			let at: Date;
			try {
				at = parseOneOff(trigger.fireAtIso, trigger.timezone);
			} catch (err) {
				// Past timestamp (e.g. a one-off that fired in a previous
				// session before we wrote `fired: true`, or one whose
				// schedule was set in the past to begin with). Mark it
				// spent so we don't log on every reload, and persist.
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("in the past")) {
					trigger.fired = true;
					void saveStore(runtime.store, runtime.storeGeneration);
				} else {
					console.warn(`[pi-routines] one-off arm failed for '${routine.name}':`, err);
				}
				return null;
			}
			const delay = Math.max(0, at.getTime() - Date.now());
			return setTimeout(() => {
				onFire();
				// Mark spent and persist so /reload doesn't re-arm.
				trigger.fired = true;
				void saveStore(runtime.store, runtime.storeGeneration);
				const arr = runtime.timers.get(routine.id);
				if (arr) arr[triggerIndex] = null;
			}, delay) as unknown as ReturnType<typeof setInterval>;
		}
		case "hook":
			return null; // armed by hooks.ts
		case "github":
			return armGithubPoller(routine, triggerIndex, runtime, pi, getCtx);
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
		enqueueTriggerFire(routine, triggerIndex, runtime, pi, getCtx);
	} catch (err) {
		if (isStaleCtxError(err)) {
			unscheduleRoutine(routine.id, runtime);
			console.warn(`[pi-routines] scheduler: stale ctx, stopping '${routine.name}'`);
			return;
		}
		console.error(`[pi-routines] scheduler tick '${routine.name}' failed:`, err);
	}
}

/**
 * Shared enqueue path. Used by the time-based scheduler and by the GitHub
 * poller (TP-011). Performs: existence check, multi-trigger collapse,
 * dedup-vs-queued, backpressure trim, triggerOrigin record, push, drain.
 *
 * Throws on stale ctx; callers should treat that as a teardown signal.
 */
export function enqueueTriggerFire(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	const live = runtime.store.routines[routine.id];
	if (!live) {
		unscheduleRoutine(routine.id, runtime);
		return;
	}

	// Paused routines silently drop scheduled / api / github fires. Manual
	// fires (/routine-run-now) bypass this path entirely. We still consume
	// the trigger origin marker so the next fire isn't tagged with stale
	// metadata.
	if (live.paused) {
		const trigger = live.triggers[triggerIndex];
		if (trigger) {
			recordSkippedFire(
				runtime,
				runtime.store,
				live,
				{ index: triggerIndex, kind: trigger.kind },
				"paused",
			);
		}
		runtime.triggerOrigin.delete(routine.id);
		return;
	}

	const now = Date.now();
	const enq = getEnqueueMap(runtime);
	const last = enq.get(routine.id) ?? 0;
	const trigger = live.triggers[triggerIndex];
	if (!trigger) return;
	if (now - last < MULTI_TRIGGER_COLLAPSE_MS) {
		recordSkippedFire(
			runtime,
			runtime.store,
			live,
			{ index: triggerIndex, kind: trigger.kind },
			"collapsed duplicate trigger",
		);
		return;
	}
	enq.set(routine.id, now);

	if (queueHasRoutine(runtime, routine.id)) {
		recordSkippedFire(
			runtime,
			runtime.store,
			live,
			{ index: triggerIndex, kind: trigger.kind },
			"routine already queued",
		);
		return;
	}

	enqueueRoutineFire(live, { index: triggerIndex, kind: trigger.kind }, runtime, pi, getCtx);
}

/**
 * Enqueue a specific fire with per-fire payload. Unlike `enqueueTriggerFire`,
 * this can queue multiple entries for the same routine, matching Claude-style
 * API/GitHub behavior where each matching event is its own run.
 */
export function enqueueFireRequest(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
	payload: QueueMetadata = {},
): string | null {
	const live = runtime.store.routines[routine.id];
	if (!live) {
		unscheduleRoutine(routine.id, runtime);
		return null;
	}
	const trigger = live.triggers[triggerIndex];
	if (!trigger) return null;
	const origin = { index: triggerIndex, kind: trigger.kind };
	if (live.paused) {
		const runId = payload.runId ?? nanoid();
		recordSkippedFire(runtime, runtime.store, live, origin, "paused", runId);
		return runId;
	}
	return enqueueRoutineFire(live, origin, runtime, pi, getCtx, payload);
}

/**
 * Re-enqueue queued fires that survived a previous session's teardown via
 * `store.pendingQueue`. Called once per interactive `session_start`, after
 * the store is loaded and before timers / hook picks enqueue fresh work.
 *
 * Per-entry fate:
 *   - owning routine deleted     → dropped (already filtered at load; this
 *                                  is a defensive console.warn only)
 *   - `session_start` hook fire  → skipped (`"superseded by fresh
 *                                  session_start hook"`): the lifecycle
 *                                  pick below re-enqueues it anyway
 *   - routine paused             → skipped (`"paused"`), matching the live
 *                                  enqueue gate
 *   - older than MAX_QUEUED_FIRE_AGE_MS → skipped (`"queued fire expired"`)
 *     rather than firing stale work
 *   - duplicate of an already-queued single-fire origin (anything except
 *     api/github, which legitimately stack) → skipped (`"routine already
 *     queued"`)
 *   - otherwise                  → re-enqueued with its original runId,
 *                                  queuedAt, payloads, and hook-once keys
 *
 * The persisted list is cleared up front (and the clear committed to disk)
 * BEFORE anything can fire: entries re-enter via `enqueueRoutineFire`, whose
 * own persistQueue write-through re-mirrors them, so a crash mid-rehydrate
 * cannot double-fire work that already started.
 */
export function rehydrateQueuedFires(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	const persisted = runtime.store.pendingQueue ?? [];
	if (persisted.length === 0) return;
	runtime.store.pendingQueue = [];
	void saveStore(runtime.store, runtime.storeGeneration);

	const now = Date.now();
	const seenSingleFire = new Set<string>();
	for (const entry of persisted) {
		const routine = runtime.store.routines[entry.routineId];
		if (!routine) {
			console.warn(`[pi-routines] dropping queued fire for unknown routine '${entry.routineId}'`);
			continue;
		}
		const origin = entry.origin;
		const trigger = routine.triggers[origin.index];
		if (origin.kind === "hook" && trigger?.kind === "hook" && trigger.event === "session_start") {
			recordSkippedFire(
				runtime,
				runtime.store,
				routine,
				origin,
				"superseded by fresh session_start hook",
				entry.runId,
			);
			continue;
		}
		if (routine.paused) {
			recordSkippedFire(runtime, runtime.store, routine, origin, "paused", entry.runId);
			continue;
		}
		const queuedAt = entry.queuedAt ?? now;
		if (now - queuedAt > MAX_QUEUED_FIRE_AGE_MS) {
			recordSkippedFire(
				runtime,
				runtime.store,
				routine,
				origin,
				"queued fire expired",
				entry.runId,
			);
			continue;
		}
		// api/github origins legitimately stack multiple entries per routine
		// (one per event); every other origin fires once per routine at a time.
		const stacksPerRoutine = origin.kind === "api" || origin.kind === "github";
		if (
			!stacksPerRoutine &&
			(seenSingleFire.has(routine.id) || queueHasRoutine(runtime, routine.id))
		) {
			recordSkippedFire(
				runtime,
				runtime.store,
				routine,
				origin,
				"routine already queued",
				entry.runId,
			);
			continue;
		}
		seenSingleFire.add(routine.id);
		enqueueRoutineFire(routine, origin, runtime, pi, getCtx, {
			runId: entry.runId,
			queuedAt,
			apiArgs: entry.apiArgs,
			githubEvent: entry.githubEvent,
			contextNote: entry.contextNote,
			hookOnceKey: entry.hookOnceKey,
			hookOnce: entry.hookOnce,
			autoDrain: false,
		});
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

// ─── Drain watchdog ──────────────────────────────────────────────────────────
//
// `drainQueue` is only invoked at enqueue-time (autoDrain), `agent_end`,
// `session_start`, and manual commands. If the session is busy at every one
// of those moments, a queued fire would starve indefinitely. The watchdog is
// an unref'd retry timer that re-attempts the drain while the queue is
// non-empty. Invariant: armed iff `runtime.queue.length > 0` (and the
// runtime is not torn down).

const DEFAULT_DRAIN_RETRY_MS = 60_000;
const MIN_DRAIN_RETRY_MS = 5_000;
const MAX_DRAIN_RETRY_MS = 600_000;

/**
 * Idle-watch retry cadence for the drain watchdog. Overridable via
 * `PI_ROUTINES_DRAIN_RETRY_MS` (integer ms); unparseable values fall back to
 * 60s and every value is clamped to [5s, 10min]. Read at arm time.
 */
export function drainRetryMs(): number {
	const parsed = Number.parseInt(process.env.PI_ROUTINES_DRAIN_RETRY_MS ?? "", 10);
	if (Number.isNaN(parsed)) return DEFAULT_DRAIN_RETRY_MS;
	return Math.min(Math.max(parsed, MIN_DRAIN_RETRY_MS), MAX_DRAIN_RETRY_MS);
}

/**
 * Arm the idle-watch retry timer. No-op when already armed. The handle is
 * unref'd so it never keeps the process alive on its own. A tick whose queue
 * has gone empty disarms instead of draining; `drainQueue`'s own stale-ctx
 * defence (stopScheduler on teardown) covers disposal.
 */
export function armDrainWatchdog(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	if (runtime.drainWatchdog) return;
	const handle = setInterval(() => {
		if (runtime.queue.length === 0) {
			disarmDrainWatchdog(runtime);
			return;
		}
		void drainQueue(runtime, pi, getCtx).catch((err) => {
			console.error("[pi-routines] drain watchdog tick failed:", err);
		});
	}, drainRetryMs());
	handle.unref();
	runtime.drainWatchdog = handle;
}

/** Clear the idle-watch retry timer. Safe to call when not armed. */
export function disarmDrainWatchdog(runtime: RoutineRuntimeState): void {
	if (!runtime.drainWatchdog) return;
	clearInterval(runtime.drainWatchdog);
	runtime.drainWatchdog = null;
}

/**
 * Maintain the watchdog invariant — armed iff the fire queue is non-empty.
 * Must be called after every queue mutation (enqueue, drain, teardown).
 */
export function reconcileDrainWatchdog(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): void {
	if (runtime.queue.length > 0) {
		armDrainWatchdog(runtime, pi, getCtx);
	} else {
		disarmDrainWatchdog(runtime);
	}
}

/**
 * Drain queued routine ids while the session is idle. Stops at the first
 * not-idle indicator (busy ctx, pending messages, in-flight routine turn).
 * Re-entrant calls (watchdog tick racing agent_end / autoDrain) return
 * immediately; the in-flight drain re-arms the watchdog on exit if work
 * remains.
 */
export async function drainQueue(
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): Promise<void> {
	if (runtime.draining) return;
	runtime.draining = true;
	try {
		while (runtime.queue.length > 0) {
			let ctx: ExtensionContext | null;
			try {
				ctx = getCtx();
			} catch (err) {
				if (isStaleCtxError(err)) {
					console.warn(`[pi-routines] drainQueue: stale ctx; stopping all timers`);
					stopScheduler(runtime, "stale extension context");
					return;
				}
				throw err;
			}
			if (!ctx) return;
			if (guard.isRoutineTurnActive(runtime)) return;
			if (!ctx.isIdle()) return;
			if (ctx.hasPendingMessages()) return;

			const entry = runtime.queue.shift();
			if (!entry) return;
			// Persist the removal BEFORE opening a turn: a crash mid-turn must
			// not leave the entry on disk to be rehydrated into a second fire.
			await persistQueue(runtime);
			const id = queueEntryRoutineId(entry);
			const routine = runtime.store.routines[id];
			if (!routine) {
				if (entry.deferredHookId) {
					runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
						(item) => item.id !== entry.deferredHookId,
					);
					await saveStore(runtime.store, runtime.storeGeneration);
				}
				continue;
			}

			// Belt-and-braces pause gate. The primary gate is at enqueue
			// (`enqueueTriggerFire`) and at hook pick (`pickHookRoutines`), but a
			// routine may be paused AFTER it was queued: e.g. user pauses while
			// another routine is mid-turn. Manual fires (origin.kind === "manual")
			// are the explicit override path and ignore the flag.
			if (routine.paused) {
				if (entry.origin.kind !== "manual") {
					runtime.apiArgs?.delete(id);
					runtime.githubEvents?.delete(id);
					if (entry.deferredHookId) {
						runtime.store.deferredHooks = runtime.store.deferredHooks.filter(
							(item) => item.id !== entry.deferredHookId,
						);
					}
					recordSkippedFire(runtime, runtime.store, routine, entry.origin, "paused", entry.runId);
					continue;
				}
			}

			runtime.lastUiCtx = ctx;
			await fireRoutine(routine, runtime, runtime.store, pi, ctx, entry);
		}
	} finally {
		runtime.draining = false;
		reconcileDrainWatchdog(runtime, pi, getCtx);
	}
}
