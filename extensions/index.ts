/**
 * @file extensions/index.ts — single entry point for the pi-routines extension.
 *
 * Responsibilities:
 *   1. Create the singleton {@link RoutineRuntimeState} for this load.
 *   2. Wire prior modules in a fixed order: tools → slash commands →
 *      suppressor → lifecycle hooks → input tracker.
 *   3. Maintain `currentCtx` so the scheduler and the widget-refresh
 *      interval can resolve a live `ExtensionContext` after the originating
 *      event handler has returned.
 *   4. Register a hot-reload cleanup function on `globalThis` (key
 *      `__piRoutinesCleanup`) — mirrors `pi-subagents/src/extension/index.ts`
 *      so `/reload` does not leak setInterval handles into the new instance.
 *   5. Branch on `ctx.hasUI` in `session_start` (handled inside `hooks.ts`)
 *      so print-mode invocations register tools but never start timers or
 *      touch the widget.
 *
 * Does NOT own:
 *   - The contents of any individual subscriber (see `hooks.ts`).
 *   - Tool / command argument validation (see `tools/*` and `commands/*`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRoutineCommand } from "../src/commands/routine.ts";
import { registerRoutineExportCronCommand } from "../src/commands/routine-export-cron.ts";
import { registerRoutineInstallCommand } from "../src/commands/routine-install.ts";
import { registerRoutineOnCommand } from "../src/commands/routine-on.ts";
import { registerRoutineStopCommand } from "../src/commands/routine-stop.ts";
import { registerRoutinesCommand } from "../src/commands/routines.ts";
import { registerHooks, registerInputTracker } from "../src/hooks.ts";
import { stopScheduler } from "../src/scheduler.ts";
import { emptyStore } from "../src/store.ts";
import { registerSuppressor } from "../src/suppressor.ts";
import { registerRoutineCreateTool } from "../src/tools/routine-create.ts";
import { registerRoutineDeleteTool } from "../src/tools/routine-delete.ts";
import { registerRoutineListTool } from "../src/tools/routine-list.ts";
import { registerRoutineSetStateTool } from "../src/tools/routine-set-state.ts";
import type { RoutineRuntimeState } from "../src/types.ts";
import { clearWidget, startWidgetRefresh } from "../src/widget.ts";

const CLEANUP_KEY = "__piRoutinesCleanup";

export default function registerRoutinesExtension(pi: ExtensionAPI): void {
	// ─── Hot-reload cleanup ────────────────────────────────────────────────
	// On `/reload`, the previous extension instance left a cleanup function
	// on globalThis. Invoke it BEFORE we wire up new timers so the old
	// intervals do not double-fire alongside ours.
	const globalStore = globalThis as Record<string, unknown>;
	const previousCleanup = globalStore[CLEANUP_KEY];
	if (typeof previousCleanup === "function") {
		try {
			(previousCleanup as () => void)();
		} catch {
			// Best-effort; old instance is gone either way.
		}
	}

	// ─── Singleton runtime state for this load ─────────────────────────────
	const runtime: RoutineRuntimeState = {
		store: emptyStore(), // overwritten by session_start → loadStore
		timers: new Map(),
		queue: [],
		isRoutineTurnActive: false,
		activeRoutineName: null,
		lastUiCtx: null,
	};

	// ─── Live ctx accessor for scheduler / widget refresh ──────────────────
	let currentCtx: ExtensionContext | null = null;
	const getCtx = (): ExtensionContext | null => currentCtx;
	const setCtx = (ctx: ExtensionContext): void => {
		currentCtx = ctx;
		runtime.lastUiCtx = ctx;
	};

	// ─── Register in fixed order ───────────────────────────────────────────
	// 1. Tools (always — even in print mode the LLM may call them).
	registerRoutineCreateTool(pi, runtime, getCtx);
	registerRoutineListTool(pi, runtime);
	registerRoutineDeleteTool(pi, runtime);
	registerRoutineSetStateTool(pi, runtime);

	// 2. Slash commands.
	registerRoutineCommand(pi, runtime, getCtx);
	registerRoutinesCommand(pi, runtime);
	registerRoutineOnCommand(pi, runtime, getCtx);
	registerRoutineStopCommand(pi, runtime);
	registerRoutineInstallCommand(pi, runtime, getCtx);
	registerRoutineExportCronCommand(pi, runtime);

	// 3. Suppressor (message_end interceptor for `[~]`).
	registerSuppressor(pi, runtime);

	// 4. Hooks + input tracker.
	registerHooks(pi, runtime, getCtx, setCtx);
	registerInputTracker(pi, runtime);

	// ─── Widget refresh loop ───────────────────────────────────────────────
	// `startWidgetRefresh` is a no-op when no pulse routines exist OR when
	// invoked before session_start has populated `runtime.store`. We start
	// it eagerly anyway because the loop itself is gated by `getCtx()` /
	// `ctx.hasUI` checks inside `updateWidget`.
	const stopWidgetRefresh = startWidgetRefresh(runtime, getCtx);

	// Keep `currentCtx` fresh on tool_result too — tools can run via async
	// flows that race the next lifecycle event.
	pi.on("tool_result", (_event, ctx) => {
		setCtx(ctx);
	});

	// ─── Cleanup registration ──────────────────────────────────────────────
	const cleanup = (): void => {
		try {
			stopScheduler(runtime);
		} catch {
			/* swallow during teardown */
		}
		try {
			stopWidgetRefresh();
		} catch {
			/* swallow during teardown */
		}
		try {
			const ctx = currentCtx;
			if (ctx) clearWidget(ctx);
		} catch {
			/* swallow during teardown */
		}
	};
	globalStore[CLEANUP_KEY] = cleanup;
}
