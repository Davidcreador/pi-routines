/**
 * @file hooks.ts — pi lifecycle subscribers that drive the routine lifecycle.
 *
 * Owns:
 *   - `session_start` — load persisted store, schedule pulse routines, fire
 *     applicable `session_start` hook routines, refresh the widget.
 *   - `agent_end` — release the recursion guard if a routine turn just
 *     finished, drain any queued pulses, and (only on user-driven turns)
 *     fire AT MOST ONE applicable `agent_end` hook routine.
 *   - `session_shutdown` — stop timers, run shutdown hooks (only on `"quit"`,
 *     never on `"reload"`), persist the store, clear the widget.
 *   - `input` — belt-and-suspenders tracker for input events tagged
 *     `source: "extension"` while a routine turn is in flight, so reviewers
 *     can see the recursion-guard path in the log.
 *
 * Does NOT own:
 *   - Timer plumbing — that's `scheduler.ts`.
 *   - Prompt build / `sendUserMessage` — that's `executor.ts` (via
 *     `drainQueue`).
 *   - Silent-token suppression — that's `suppressor.ts` (TP-003).
 *   - Hot-reload `globalThis` cleanup — that's `extensions/index.ts` (TP-006).
 *
 * The guard contract: `fireRoutine` calls `acquireRoutineTurn` before
 * `sendUserMessage`. The very next `agent_end` releases it here. If
 * `agent_end` arrives with the flag clear, the turn was user-driven and
 * (subject to once-semantics) we may fire ONE hook routine.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fireRoutine, recordRun } from "./executor.ts";
import * as guard from "./guard.ts";
import { drainQueue, scheduleRoutine, stopScheduler } from "./scheduler.ts";
import { loadStore, saveStore } from "./store.ts";
import type { HookTrigger, Routine, RoutineRuntimeState } from "./types.ts";
import { clearWidget, updateWidget } from "./widget.ts";

/**
 * Register the three lifecycle handlers (`session_start`, `agent_end`,
 * `session_shutdown`). Call exactly once per extension load.
 *
 * @param setCtx Called whenever a new `ExtensionContext` is observed
 * (`session_start`, `agent_end`). The extension entry point uses this to
 * update its `currentCtx` so `getCtx()` returns a live reference for the
 * scheduler / widget refresh interval.
 */
export function registerHooks(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
	setCtx: (ctx: ExtensionContext) => void,
): void {
	pi.on("session_start", async (event, ctx) => {
		setCtx(ctx);
		runtime.lastUiCtx = ctx;

		// Reset guard state — a fresh session never inherits in-flight flags.
		guard.releaseRoutineTurn(runtime);

		// Reload the persisted store. tickState is preserved across reload
		// but in-memory `timers`/`queue` are wiped on each load.
		runtime.store = await loadStore();
		runtime.timers.clear();
		runtime.queue.length = 0;

		// Print mode: register-only path. No timers, no widget, no hook fires.
		if (!ctx.hasUI) return;

		// Re-arm timers for every routine; scheduler decides per trigger.
		for (const routine of Object.values(runtime.store.routines)) {
			scheduleRoutine(routine, runtime, pi, getCtx);
		}

		// Fire applicable session_start hook routines (sequentially).
		const isReload = event.reason === "reload";
		for (const { routine, trigger, index } of pickHookRoutines(runtime, "session_start")) {
			// On reload, suppress per_session hooks — the session continues.
			if (isReload && trigger.once === "per_session") {
				continue;
			}
			if (!guard.shouldFireHook(trigger, runtime.store.tickState[routine.id])) {
				continue;
			}
			try {
				runtime.triggerOrigin.set(routine.id, { index, kind: "hook" });
				await fireRoutine(routine, runtime, runtime.store, pi, ctx);
			} catch (err) {
				console.error(`[pi-routines] session_start hook '${routine.name}' failed:`, err);
			}
		}

		updateWidget(runtime, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		setCtx(ctx);
		runtime.lastUiCtx = ctx;

		// Snapshot BEFORE release: was this turn driven by a routine?
		const wasRoutineTurn = guard.isRoutineTurnActive(runtime);
		if (wasRoutineTurn) {
			guard.releaseRoutineTurn(runtime);
		}

		// Finalise pending run record from the routine turn that just ended.
		if (wasRoutineTurn && runtime.pendingRun) {
			const pr = runtime.pendingRun;
			const endedAt = Date.now();
			recordRun(runtime, runtime.store, {
				id: pr.runId,
				routineId: pr.routineId,
				startedAt: pr.startedAt,
				endedAt,
				durationMs: endedAt - pr.startedAt,
				status: pr.status,
				triggerIndex: pr.triggerIndex,
				triggerKind: pr.triggerKind,
				snippet: pr.snippet,
			});
			runtime.pendingRun = null;
		}

		// Always drain — newly idle ctx may unblock queued pulse routines.
		try {
			await drainQueue(runtime, pi, getCtx);
		} catch (err) {
			console.error(`[pi-routines] drainQueue on agent_end failed:`, err);
		}

		// Fire AT MOST ONE agent_end hook — but ONLY on user-driven turns.
		// Routine-driven turns must never chain into another routine to avoid
		// runaway feedback loops.
		if (!wasRoutineTurn && ctx.hasUI) {
			for (const { routine, trigger, index } of pickHookRoutines(runtime, "agent_end")) {
				if (!guard.shouldFireHook(trigger, runtime.store.tickState[routine.id])) {
					continue;
				}
				try {
					runtime.triggerOrigin.set(routine.id, { index, kind: "hook" });
					await fireRoutine(routine, runtime, runtime.store, pi, ctx);
				} catch (err) {
					console.error(`[pi-routines] agent_end hook '${routine.name}' failed:`, err);
				}
				break; // hard cap: one per turn
			}
		}

		if (ctx.hasUI) updateWidget(runtime, ctx);
	});

	pi.on("session_shutdown", async (event) => {
		const ctx = getCtx();

		// Tear down timers + queue first so a shutdown hook that schedules
		// new pulses cannot leak intervals past the runtime.
		stopScheduler(runtime);

		// Fire shutdown hooks ONLY on real quit and only when no routine
		// turn is currently active. On `reload`, the extension is being
		// torn down to be re-loaded immediately — the new instance will run
		// `session_start` for us; firing shutdown hooks would double-trigger.
		const shouldFireShutdown =
			event.reason === "quit" && !guard.isRoutineTurnActive(runtime) && ctx !== null;
		if (shouldFireShutdown) {
			for (const { routine, trigger, index } of pickHookRoutines(runtime, "session_shutdown")) {
				if (!guard.shouldFireHook(trigger, runtime.store.tickState[routine.id])) {
					continue;
				}
				try {
					runtime.triggerOrigin.set(routine.id, { index, kind: "hook" });
					await fireRoutine(routine, runtime, runtime.store, pi, ctx);
				} catch (err) {
					console.error(`[pi-routines] session_shutdown hook '${routine.name}' failed:`, err);
				}
			}
		}

		// Persist the (possibly updated by hooks) store.
		try {
			await saveStore(runtime.store);
		} catch (err) {
			console.error(`[pi-routines] saveStore on shutdown failed:`, err);
		}

		if (ctx) clearWidget(ctx);

		// Final reset — defensive; the runtime is about to be discarded.
		guard.releaseRoutineTurn(runtime);
	});
}

/**
 * Belt-and-suspenders observer for `input` events. The recursion guard's
 * authoritative signal is `runtime.isRoutineTurnActive`; this handler exists
 * purely so the path is visible in logs when an `extension`-sourced input
 * arrives while a routine turn is in flight.
 *
 * Returns nothing (lets the input continue unchanged).
 */
export function registerInputTracker(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.on("input", (event) => {
		if (event.source === "extension" && guard.isRoutineTurnActive(runtime)) {
			console.error(
				`[pi-routines] extension input under active routine guard ('${runtime.activeRoutineName ?? "?"}')`,
			);
		}
		return { action: "continue" };
	});
}

// ─── internals ───────────────────────────────────────────────────────────────

function pickHookRoutines(
	runtime: RoutineRuntimeState,
	event: "session_start" | "agent_end" | "session_shutdown",
): Array<{ routine: Routine; trigger: HookTrigger; index: number }> {
	const out: Array<{ routine: Routine; trigger: HookTrigger; index: number }> = [];
	for (const routine of Object.values(runtime.store.routines)) {
		// Paused routines never fire on hooks (matches the scheduler gate).
		if (routine.paused) continue;
		for (let i = 0; i < routine.triggers.length; i++) {
			const trigger = routine.triggers[i];
			if (trigger && trigger.kind === "hook" && trigger.event === event) {
				out.push({ routine, trigger, index: i });
				break; // one entry per routine per event
			}
		}
	}
	return out;
}
