/**
 * @file routine-list.ts — LLM-callable `RoutineList` tool.
 *
 * Returns every active routine alphabetically with trigger description,
 * tick count, last-fire (relative), quiet flag, and optional maxTicks.
 * `renderResult` formats a column-aligned table for the TUI.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describeTriggers, relativeTime } from "../format.ts";
import type { Routine, RoutineRuntimeState } from "../types.ts";

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

/**
 * Register the `RoutineList` tool.
 *
 * The LLM calls this to inspect what routines are currently active.
 * Useful for self-introspection (e.g. before deleting one) and for
 * answering user questions like "what routines do I have running?".
 */
export function registerRoutineListTool(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerTool({
		name: "RoutineList",
		label: "Routine: List",
		description:
			"List all active routines (pulse + hook) with trigger, tick count, " +
			"last-fire time, and flags. Takes no parameters.",
		parameters: Type.Object({}),

		async execute(): Promise<AgentToolResult<Details>> {
			const sorted: Routine[] = Object.values(runtime.store.routines).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
			const rows: RoutineRow[] = sorted.map((r) => {
				const tick = runtime.store.tickState[r.id];
				return {
					id: r.id,
					name: r.name,
					triggerDescription: describeTriggers(r.triggers),
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
				[r.quiet ? "quiet" : "", r.maxTicks !== undefined ? `max=${r.maxTicks}` : ""]
					.filter(Boolean)
					.join(" "),
			]);
			const all = [headers, ...data];
			const widths = headers.map((_, col) => Math.max(...all.map((row) => row[col]?.length ?? 0)));
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
