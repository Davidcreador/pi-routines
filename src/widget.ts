/**
 * @file widget.ts — footer status line summarising active routines.
 *
 * Uses `ctx.ui.setStatus("routines", text)` so the line composes with other
 * extensions' status entries rather than clobbering the footer (which
 * `setFooter` would do). All functions are no-ops when `ctx.hasUI === false`,
 * so print-mode and headless sessions stay clean.
 *
 * Refresh strategy: `updateWidget` is fire-and-forget on each routine
 * lifecycle event. `startWidgetRefresh` adds a low-frequency interval
 * (default 10s) so "next fire in Xm" countdowns drift down smoothly without
 * waking on every second. If no timed routines are active and the fire queue
 * is empty we skip the interval entirely.
 *
 * Health surfacing: when the fire queue is non-empty the line shows a
 * queue-age warning (starvation is otherwise invisible until someone reads
 * `/routine-runs`), and when any routine recorded skipped runs in the last
 * 24h the line shows a `N skips/24h` counter.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Routine, RoutineRuntimeState } from "./types.ts";

const STATUS_KEY = "routines";
const DEFAULT_REFRESH_MS = 10_000;
const MAX_DISPLAYED = 3;
const NAME_MAX_LEN = 12;

/** Trailing window for the widget's skip-rate counter. */
const SKIPPED_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Recompute the footer status text from `runtime` and publish it via
 * `ctx.ui.setStatus`. No-op when `ctx.hasUI` is false. When no routines are
 * configured, clears the status entry.
 */
export function updateWidget(runtime: RoutineRuntimeState, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const routines = Object.values(runtime.store.routines);
	if (routines.length === 0) {
		clearWidget(ctx);
		return;
	}
	const text = formatStatus(routines, runtime);
	ctx.ui.setStatus(STATUS_KEY, text);
}

/**
 * Clear the routines status entry. Safe to call even if it was never set or
 * if there is no UI.
 */
export function clearWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

/**
 * Start a periodic refresh that calls {@link updateWidget} every
 * `intervalMs` (default 10 000). Used to keep pulse countdowns accurate
 * between explicit lifecycle updates.
 *
 * Returns an idempotent stop function. If no timed routines exist at call
 * time AND the fire queue is empty, the interval is not started and the
 * returned stop is a no-op — call `startWidgetRefresh` again after creating
 * a pulse routine. A non-empty queue starts the interval even without timed
 * routines so the queue-age warning keeps ticking while work starves.
 */
export function startWidgetRefresh(
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
	intervalMs: number = DEFAULT_REFRESH_MS,
): () => void {
	const hasTimed = Object.values(runtime.store.routines).some((r) =>
		r.triggers.some((t) => t.kind === "pulse" || t.kind === "cron" || t.kind === "oneoff"),
	);
	if (!hasTimed && runtime.queue.length === 0) return () => {};

	const handle = setInterval(() => {
		const ctx = getCtx();
		if (!ctx) return;
		updateWidget(runtime, ctx);
	}, intervalMs);

	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(handle);
	};
}

/** Restart the periodic refresh loop to match the current store contents. */
export function restartWidgetRefresh(
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
	intervalMs: number = DEFAULT_REFRESH_MS,
): void {
	stopWidgetRefresh(runtime);
	runtime.stopWidgetRefresh = startWidgetRefresh(runtime, getCtx, intervalMs);
}

/** Stop the periodic refresh loop, if one is active. */
export function stopWidgetRefresh(runtime: RoutineRuntimeState): void {
	if (!runtime.stopWidgetRefresh) return;
	const stop = runtime.stopWidgetRefresh;
	runtime.stopWidgetRefresh = undefined;
	stop();
}

// ─── internals ───────────────────────────────────────────────────────────────

function formatStatus(routines: Routine[], runtime: RoutineRuntimeState): string {
	const head = routines.slice(0, MAX_DISPLAYED);
	const rest = routines.length - head.length;
	const entries = head.map((r) => `${truncateName(r.name)}(${tag(r, runtime)})`);
	const tail = rest > 0 ? `  +${rest} more` : "";
	return `↺ ${routines.length} active  ${entries.join(" · ")}${tail}${formatHealth(runtime)}`;
}

/**
 * Queue-age and skip-rate health segments, appended only when something
 * needs attention. Empty string when the queue is empty and no routine
 * recorded a skipped run in the last {@link SKIPPED_WINDOW_MS}.
 */
function formatHealth(runtime: RoutineRuntimeState): string {
	const segments: string[] = [];
	if (runtime.queue.length > 0) {
		const oldest = oldestQueuedAgeMs(runtime);
		segments.push(
			oldest === null
				? `⚠ ${runtime.queue.length} queued`
				: `⚠ ${runtime.queue.length} queued, oldest ${formatAge(oldest)}`,
		);
	}
	const skips = skippedRunsInWindow(runtime);
	if (skips > 0) segments.push(`${skips} skips/24h`);
	return segments.length > 0 ? `  ${segments.join(" · ")}` : "";
}

/** Age of the longest-waiting queued fire; null when no entry carries a timestamp. */
function oldestQueuedAgeMs(runtime: RoutineRuntimeState): number | null {
	let oldest: number | null = null;
	for (const entry of runtime.queue) {
		if (typeof entry.queuedAt !== "number") continue;
		const age = Date.now() - entry.queuedAt;
		oldest = oldest === null ? age : Math.max(oldest, age);
	}
	return oldest;
}

function formatAge(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Skipped runs across all routines within the trailing 24h window. */
function skippedRunsInWindow(runtime: RoutineRuntimeState): number {
	const cutoff = Date.now() - SKIPPED_WINDOW_MS;
	let count = 0;
	for (const tickState of Object.values(runtime.store.tickState)) {
		for (const run of tickState.runs ?? []) {
			if (run.status === "skipped" && run.startedAt >= cutoff) count++;
		}
	}
	return count;
}

function lastRunGlyph(runtime: RoutineRuntimeState, routineId: string): string {
	const runs = runtime.store.tickState[routineId]?.runs;
	if (!runs || runs.length === 0) return "";
	const last = runs[runs.length - 1];
	switch (last?.status) {
		case "success":
			return "✓";
		case "error":
			return "✗";
		case "silent":
			return "~";
		case "skipped":
			return "—";
		default:
			return "";
	}
}

function tag(routine: Routine, runtime: RoutineRuntimeState): string {
	const primary = routine.triggers[0];
	const glyph = lastRunGlyph(runtime, routine.id);
	const suffix = glyph ? ` ${glyph}` : "";
	if (routine.paused) return `paused${suffix}`;
	if (!primary) return `-${suffix}`;
	if (primary.kind === "hook") return `${primary.event}${suffix}`;
	if (primary.kind === "cron") return `cron${suffix}`;
	if (primary.kind === "oneoff") return `1x${suffix}`;
	if (primary.kind === "api") return `api${suffix}`;
	if (primary.kind === "github") return `gh${suffix}`;
	const tickState = runtime.store.tickState[routine.id];
	if (routine.quiet) {
		return `q·${tickState?.tickCount ?? 0}${suffix}`;
	}
	const minutes = minutesUntilNext(routine, tickState?.lastFiredAt);
	return `${minutes}m${suffix}`;
}

function minutesUntilNext(routine: Routine, lastFiredAt: number | undefined): number {
	const primary = routine.triggers[0];
	if (!primary || primary.kind !== "pulse") return 0;
	const interval = primary.intervalMs;
	const anchor = lastFiredAt ?? routine.createdAt;
	const elapsedInCycle = (Date.now() - anchor) % interval;
	const remainingMs = interval - elapsedInCycle;
	return Math.max(0, Math.ceil(remainingMs / 60_000));
}

function truncateName(name: string): string {
	if (name.length <= NAME_MAX_LEN) return name;
	return `${name.slice(0, NAME_MAX_LEN - 1)}…`;
}
