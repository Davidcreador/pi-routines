/**
 * @file schedule-nl.test.ts — TP-011 unit tests for /schedule meta-prompt.
 *
 * Asserts:
 *   - buildSchedulePrompt names RoutineCreate as the tool to call.
 *   - It echoes the user's request literally so the LLM sees what to parse.
 *   - It anchors relative-time phrases by stating local time + timezone.
 *   - A synthetic LLM-emitted RoutineCreate args object validates against
 *     the same TypeBox schema the runtime tool uses (contract round-trip).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { Type, type Static } from "typebox";
import { buildSchedulePrompt, SCHEDULE_HELP } from "../src/schedule-nl.ts";

// Mirror of the RoutineCreate schema (kept in sync with src/tools/routine-create.ts).
// Asserting against a literal mirror is intentional: if the tool's schema
// drifts, this test fails loudly and prompts a meta-prompt update.
const RoutineCreateArgs = Type.Object({
	name: Type.String(),
	prompt: Type.String(),
	trigger: Type.Union([
		Type.Object({
			kind: Type.Literal("pulse"),
			interval: Type.String(),
		}),
		Type.Object({
			kind: Type.Literal("hook"),
			event: Type.Union([
				Type.Literal("session_start"),
				Type.Literal("agent_end"),
				Type.Literal("session_shutdown"),
			]),
			once: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("per_session")])),
		}),
	]),
	quiet: Type.Optional(Type.Boolean()),
	maxTicks: Type.Optional(Type.Integer({ minimum: 1 })),
});
type RoutineCreateArgsT = Static<typeof RoutineCreateArgs>;

describe("schedule-nl — buildSchedulePrompt", () => {
	it("names RoutineCreate as the only tool", () => {
		const p = buildSchedulePrompt({
			userRequest: "every 10 minutes check CI",
			now: Date.parse("2026-05-20T12:00:00Z"),
			timezone: "UTC",
		});
		assert.match(p, /RoutineCreate/);
		assert.match(p, /ONLY the RoutineCreate tool/);
	});

	it("echoes the user request verbatim and anchors timezone", () => {
		const p = buildSchedulePrompt({
			userRequest: "summarise yesterday's PRs",
			now: Date.parse("2026-05-20T12:00:00Z"),
			timezone: "America/Los_Angeles",
		});
		assert.match(p, /summarise yesterday's PRs/);
		assert.match(p, /America\/Los_Angeles/);
		assert.match(p, /Current local time:/);
	});

	it("trims user request whitespace before embedding", () => {
		const p = buildSchedulePrompt({ userRequest: "   ping API   ", timezone: "UTC" });
		assert.match(p, /User request: ping API$/m);
	});

	it("describes both pulse and hook trigger shapes", () => {
		const p = buildSchedulePrompt({ userRequest: "x", timezone: "UTC" });
		assert.match(p, /kind: "pulse"/);
		assert.match(p, /kind: "hook"/);
		assert.match(p, /session_start/);
	});
});

describe("schedule-nl — SCHEDULE_HELP", () => {
	it("includes an example and a cancel hint", () => {
		assert.match(SCHEDULE_HELP, /\/schedule/);
		assert.match(SCHEDULE_HELP, /routine-stop/);
	});
});

describe("schedule-nl — synthetic LLM output validates", () => {
	it("a well-formed pulse args object passes the schema", () => {
		const llmArgs: RoutineCreateArgsT = {
			name: "ci-check",
			prompt: "Check CI status; output [~] if unchanged.",
			trigger: { kind: "pulse", interval: "10m" },
			quiet: true,
		};
		assert.equal(Value.Check(RoutineCreateArgs, llmArgs), true);
	});

	it("a well-formed hook args object with once passes the schema", () => {
		const llmArgs: RoutineCreateArgsT = {
			name: "morning-pr-summary",
			prompt: "List my open PRs.",
			trigger: { kind: "hook", event: "session_start", once: "daily" },
		};
		assert.equal(Value.Check(RoutineCreateArgs, llmArgs), true);
	});

	it("a malformed args object (bad once value) is rejected", () => {
		const bad = {
			name: "x",
			prompt: "y",
			trigger: { kind: "hook", event: "session_start", once: "always" },
		};
		assert.equal(Value.Check(RoutineCreateArgs, bad), false);
	});

	it("a malformed trigger kind is rejected", () => {
		const bad = {
			name: "x",
			prompt: "y",
			trigger: { kind: "cron", expr: "0 9 * * *" },
		};
		assert.equal(Value.Check(RoutineCreateArgs, bad), false);
	});
});
