/**
 * @file build-prompt.test.ts — placeholder substitution in `executor.buildPrompt`.
 *
 * Covers the full set of supported placeholders ({cwd}, {date}, {time},
 * {state}, {tickCount}, {apiArgs}, {githubEvent}) plus the userState
 * truncation behaviour and the quiet-mode footer.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildPrompt } from "../src/executor.ts";
import type { Routine, RoutineTickState } from "../src/types.ts";

function tickState(overrides: Partial<RoutineTickState> = {}): RoutineTickState {
	return {
		tickCount: 0,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
		...overrides,
	};
}

function routine(overrides: Partial<Routine> = {}): Routine {
	return {
		id: "r1",
		name: "test",
		prompt: "hello",
		triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
		context: "session",
		quiet: false,
		createdAt: 0,
		...overrides,
	};
}

describe("buildPrompt — placeholders", () => {
	it("substitutes {cwd}, {tickCount}, {state}", () => {
		const r = routine({
			prompt: "cwd={cwd} tick={tickCount} state={state}",
		});
		const ts = tickState({ tickCount: 4, userState: { ci: "green" } });
		const out = buildPrompt(r, ts, "/repo");
		assert.match(out, /cwd=\/repo/);
		assert.match(out, /tick=5/); // nextTick = tickCount + 1
		assert.match(out, /state=\{"ci":"green"\}/);
	});

	it("substitutes {apiArgs} when provided, else '{}'", () => {
		const r = routine({ prompt: "args={apiArgs}" });
		const ts = tickState();
		assert.match(buildPrompt(r, ts, "/", { alertId: "SEN-42" }), /args=\{"alertId":"SEN-42"\}/);
		assert.match(buildPrompt(r, ts, "/", null), /args=\{\}/);
	});

	it("substitutes {githubEvent} when provided, else '{}'", () => {
		const r = routine({ prompt: "evt={githubEvent}" });
		const ts = tickState();
		assert.match(
			buildPrompt(r, ts, "/", null, { number: 123, title: "fix bug" }),
			/evt=\{"number":123,"title":"fix bug"\}/,
		);
		assert.match(buildPrompt(r, ts, "/", null, null), /evt=\{\}/);
	});

	it("truncates oversized userState and notes it", () => {
		const big = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [`k${i}`, "x".repeat(100)]),
		);
		const r = routine({ prompt: "state={state}" });
		const ts = tickState({ userState: big });
		const out = buildPrompt(r, ts, "/");
		assert.match(out, /\[state truncated\]/);
		// The substituted state should be the empty object literal, not the
		// oversized payload.
		assert.match(out, /state=\{\}/);
	});

	it("appends the quiet-mode footer when routine.quiet is true", () => {
		const r = routine({ quiet: true });
		const out = buildPrompt(r, tickState(), "/");
		assert.match(out, /respond with exactly: \[~\]/);
	});

	it("omits the quiet footer when routine.quiet is false", () => {
		const out = buildPrompt(routine(), tickState(), "/");
		assert.doesNotMatch(out, /respond with exactly: \[~\]/);
	});
});
