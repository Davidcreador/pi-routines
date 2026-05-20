/**
 * @file parser.ts — interval string → milliseconds.
 *
 * Accepts forms like "30s", "5m", "1h", "1h30m", "2h 15m", "25 minutes",
 * "1 hour", optionally prefixed with "every ". Rejects intervals shorter
 * than 30s or longer than 24h with clear, user-readable error messages.
 *
 * Pure module — no I/O, no side effects.
 */

import type { ParsedInterval } from "./types.ts";

const MIN_MS = 30_000;
const MAX_MS = 24 * 60 * 60 * 1000;

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

/** Matches one `<number><unit>` segment, e.g. "1h", "30 minutes", "90s". */
const SEGMENT_RE = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;

/**
 * Parse a human interval string into `{ ms, human }`.
 *
 * @throws Error with a user-readable message on:
 *   - intervals < 30s ("Interval must be at least 30 seconds")
 *   - bare numbers with no unit ("Specify a unit: 5s, 5m, or 5h")
 *   - intervals > 24h ("Intervals over 24h should use /routine-export-cron instead")
 *   - unparseable input ("Could not parse interval: '<input>'. Examples: 5m, 1h, 90s")
 */
export function parseInterval(input: string): ParsedInterval {
	const original = input;
	let s = input.trim().toLowerCase();
	if (s.startsWith("every ")) s = s.slice("every ".length).trim();

	if (s.length === 0) {
		throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
	}

	// Bare number (no unit) → friendly message.
	if (/^\d+(?:\.\d+)?$/.test(s)) {
		throw new Error("Specify a unit: 5s, 5m, or 5h");
	}

	// Collect all <number><unit> segments and require the entire string be
	// composed of them (plus whitespace).
	const matches = Array.from(s.matchAll(SEGMENT_RE));
	if (matches.length === 0) {
		throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
	}
	const consumed = matches.reduce((n, m) => n + m[0].length, 0);
	const residual = s.replace(/\s+/g, "").replace(SEGMENT_RE, "").trim();
	if (residual.length > 0 || consumed === 0) {
		throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
	}

	let ms = 0;
	for (const m of matches) {
		const n = Number(m[1]);
		const unit = m[2];
		const factor = UNIT_MS[unit];
		if (factor === undefined) {
			throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
		}
		if (!Number.isFinite(n) || n < 0) {
			throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
		}
		ms += n * factor;
	}

	if (ms > MAX_MS) {
		throw new Error("Intervals over 24h should use /routine-export-cron instead");
	}
	if (ms < MIN_MS) {
		throw new Error("Interval must be at least 30 seconds");
	}

	return { ms, human: formatHuman(ms) };
}

/** Normalize a millisecond duration to a compact human string. */
function formatHuman(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;

	const parts: string[] = [];
	if (h > 0) parts.push(`${h}h`);
	if (m > 0) parts.push(`${m}m`);
	if (s > 0) parts.push(`${s}s`);
	return parts.length > 0 ? parts.join("") : "0s";
}

// ─── Inline self-test (run with `node --import tsx src/parser.ts`) ───────────
// Guarded so it doesn't execute when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
	const cases: Array<[string, number | "throws"]> = [
		["30s", 30_000],
		["5m", 300_000],
		["1h", 3_600_000],
		["1h30m", 5_400_000],
		["2h 15m", 8_100_000],
		["25 minutes", 1_500_000],
		["1 hour", 3_600_000],
		["every 5m", 300_000],
		["90s", 90_000],
		["0s", "throws"],
		["5", "throws"],
		["2d", "throws"],
		["9999h", "throws"],
		["banana", "throws"],
	];
	let fail = 0;
	for (const [input, expected] of cases) {
		try {
			const got = parseInterval(input);
			if (expected === "throws") {
				console.error(`FAIL ${input}: expected throw, got ${got.ms}`);
				fail++;
			} else if (got.ms !== expected) {
				console.error(`FAIL ${input}: expected ${expected}, got ${got.ms}`);
				fail++;
			}
		} catch (err) {
			if (expected !== "throws") {
				console.error(`FAIL ${input}: unexpected throw ${(err as Error).message}`);
				fail++;
			}
		}
	}
	console.log(fail === 0 ? "parser ok" : `parser FAIL (${fail})`);
	if (fail > 0) process.exit(1);
}
