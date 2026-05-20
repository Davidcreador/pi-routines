/**
 * @file routine-list.ts — LLM-callable `RoutineList` tool.
 *
 * Returns every active routine alphabetically with trigger description,
 * tick count, last-fire (relative), quiet flag, and optional maxTicks.
 * `renderResult` formats a column-aligned table for the TUI.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Routine, RoutineRuntimeState, RoutineTrigger } from "../types.ts";

interface RoutineRow {
	id: string;
	name: string;
	triggerDescription: string;
	tickCount: number;
	lastFiredAt: string;
	quiet: boolean;
	maxTicks?: number;
}

interface Details {
	routines: RoutineRow[];
}

function describeTrigger(t: RoutineTrigger): string {
	if (t.kind === "pulse") return `every ${t.intervalHuman}`;
	return t.once ? `on ${t.event} (${t.once})` : `on ${t.event}`;
}

/** Convert epoch millis to a coarse "N units ago" / "never" string. */
function relativeTime(ms: number, now: number = Date.now()): string {
	if (!ms || ms <= 0) return "never";
	const diff = now - ms;
	if (diff < 0) return "in the future";
	const sec = Math.round(diff / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
	const day = Math.round(hr / 24);
	if (day === 1) return "yesterday";
	if (day < 30) return `${day} days ago`;
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Register the `RoutineList` tool.
 *
 * The LLM calls this to inspect what routines are currently active.
 * Useful for self-introspection (e.g. before deleting one) and for
 * answering user questions like "what routines do I have running?".
 */
export function registerRoutineListTool(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
): void {
	pi.registerTool({
		name: "RoutineList",
		label: "Routine: List",
		description:
			"List all active routines (pulse + hook) with trigger, tick count, " +
			"last-fire time, and flags. Takes no parameters.",
		parameters: Type.Object({}),

		async execute(): Promise<AgentToolResult<Details>> {
			const sorted: Routine[] = Object.values(runtime.store.routines).sort(
				(a, b) => a.name.localeCompare(b.name),
			);
			const rows: RoutineRow[] = sorted.map((r) => {
				const tick = runtime.store.tickState[r.id];
				return {
					id: r.id,
					name: r.name,
					triggerDescription: describeTrigger(r.trigger),
					tickCount: tick?.tickCount ?? 0,
					lastFiredAt: relativeTime(tick?.lastFiredAt ?? 0),
					quiet: r.quiet,
					...(r.maxTicks !== undefined ? { maxTicks: r.maxTicks } : {}),
				};
			});

			const text =
				rows.length === 0
					? "No routines active."
					: rows
							.map(
								(r) =>
									`${r.name} — ${r.triggerDescription} — ticks ${r.tickCount} — last ${r.lastFiredAt}${r.quiet ? " — quiet" : ""}${r.maxTicks !== undefined ? ` — max ${r.maxTicks}` : ""}`,
							)
							.join("\n");

			return {
				content: [{ type: "text", text }],
				details: { routines: rows },
			};
		},

		renderCall() {
			return new Text("RoutineList", 0, 0);
		},

		renderResult(result) {
			const details = result.details as Details | undefined;
			if (!details || details.routines.length === 0) {
				return new Text("No routines active.", 0, 0);
			}
			// Column-aligned table.
			const headers = ["NAME", "TRIGGER", "TICKS", "LAST", "FLAGS"];
			const data = details.routines.map((r) => [
				r.name,
				r.triggerDescription,
				String(r.tickCount),
				r.lastFiredAt,
				[
					r.quiet ? "quiet" : "",
					r.maxTicks !== undefined ? `max=${r.maxTicks}` : "",
				]
					.filter(Boolean)
					.join(" "),
			]);
			const all = [headers, ...data];
			const widths = headers.map((_, col) =>
				Math.max(...all.map((row) => row[col]?.length ?? 0)),
			);
			const fmt = (row: string[]) =>
				row
					.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0))
					.join("  ")
					.trimEnd();
			const lines = [
				fmt(headers),
				fmt(headers.map((_, i) => "-".repeat(widths[i] ?? 0))),
				...data.map(fmt),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
