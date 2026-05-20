/**
 * @file routines.ts — `/routines` slash command (no arguments).
 *
 * Lists every active routine as an aligned text table: NAME · TRIGGER ·
 * TICKS · LAST · FLAGS. Empty state nudges the user toward
 * `/routine-install`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Routine, RoutineRuntimeState, RoutineTrigger } from "../types.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";

function describeTrigger(t: RoutineTrigger): string {
	if (t.kind === "pulse") return `every ${t.intervalHuman}`;
	if (t.kind === "cron") return `cron '${t.expr}'${t.timezone ? ` ${t.timezone}` : ""}`;
	if (t.kind === "oneoff") return `at ${t.fireAtIso}`;
	return t.once ? `on ${t.event} (${t.once})` : `on ${t.event}`;
}

function describeTriggers(triggers: RoutineTrigger[]): string {
	return triggers.map(describeTrigger).join(" + ");
}

function relativeTime(ms: number, now: number = Date.now()): string {
	if (!ms || ms <= 0) return "never";
	const diff = now - ms;
	if (diff < 0) return "in the future";
	const sec = Math.round(diff / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	return new Date(ms).toISOString().slice(0, 10);
}

function formatTable(routines: Routine[], runtime: RoutineRuntimeState): string {
	const headers = ["NAME", "TRIGGER", "TICKS", "LAST", "FLAGS"];
	const rows = routines.map((r) => {
		const tick = runtime.store.tickState[r.id];
		const flags = [r.quiet ? "quiet" : "", r.maxTicks !== undefined ? `max=${r.maxTicks}` : ""]
			.filter(Boolean)
			.join(" ");
		return [
			r.name,
			describeTriggers(r.triggers),
			String(tick?.tickCount ?? 0),
			relativeTime(tick?.lastFiredAt ?? 0),
			flags,
		];
	});
	const all = [headers, ...rows];
	const widths = headers.map((_, col) => Math.max(...all.map((row) => row[col]?.length ?? 0)));
	const fmt = (row: string[]) =>
		row
			.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	const lines = [
		fmt(headers),
		fmt(headers.map((_, i) => "-".repeat(widths[i] ?? 0))),
		...rows.map(fmt),
	];
	return lines.join("\n");
}

/** Register `/routines` (list all). */
export function registerRoutinesCommand(pi: ExtensionAPI, runtime: RoutineRuntimeState): void {
	pi.registerCommand("routines", {
		description: "List all active routines.",
		async handler(): Promise<void> {
			const sorted = Object.values(runtime.store.routines).sort((a, b) =>
				a.name.localeCompare(b.name),
			);
			const text =
				sorted.length === 0
					? "No active routines. Try `/routine-install ci-watch`."
					: formatTable(sorted, runtime);
			pi.sendMessage({
				customType: SYSTEM_MSG_TYPE,
				content: text,
				display: true,
			});
		},
	});
}
