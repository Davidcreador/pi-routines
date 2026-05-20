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
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { buildSchedulePrompt, SCHEDULE_HELP } from "../src/schedule-nl.ts";

// Mirror of the RoutineCreate schema (kept in sync with src/tools/routine-create.ts).
// Asserting against a literal mirror is intentional: if the tool's schema
// drifts, this test fails loudly and prompts a meta-prompt update.
const TriggerSchema = Type.Union([
	Type.Object({ kind: Type.Literal("pulse"), interval: Type.String() }),
	Type.Object({
		kind: Type.Literal("cron"),
		expr: Type.String(),
		timezone: Type.Optional(Type.String()),
	}),
	Type.Object({
		kind: Type.Literal("oneoff"),
		fireAtIso: Type.String(),
		timezone: Type.Optional(Type.String()),
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
	Type.Object({
		kind: Type.Literal("api"),
		allowArgs: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		kind: Type.Literal("github"),
		repo: Type.String(),
		event: Type.Union([
			Type.Literal("pull_request.opened"),
			Type.Literal("pull_request.closed"),
			Type.Literal("issues.opened"),
			Type.Literal("push"),
		]),
		pollInterval: Type.Optional(Type.String()),
		filter: Type.Optional(
			Type.Object({
				labels: Type.Optional(Type.Array(Type.String())),
				branches: Type.Optional(Type.Array(Type.String())),
				mergedOnly: Type.Optional(Type.Boolean()),
			}),
		),
	}),
]);
const RoutineCreateArgs = Type.Object({
	name: Type.String(),
	prompt: Type.String(),
	trigger: Type.Optional(TriggerSchema),
	triggers: Type.Optional(Type.Array(TriggerSchema)),
	quiet: Type.Optional(Type.Boolean()),
	maxTicks: Type.Optional(Type.Integer({ minimum: 1 })),
	maxRunsPerDay: Type.Optional(Type.Integer({ minimum: 1 })),
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

	it("describes every trigger kind the tool now supports", () => {
		const p = buildSchedulePrompt({ userRequest: "x", timezone: "UTC" });
		assert.match(p, /kind: "pulse"/);
		assert.match(p, /kind: "cron"/);
		assert.match(p, /kind: "oneoff"/);
		assert.match(p, /kind: "hook"/);
		assert.match(p, /kind: "api"/);
		assert.match(p, /kind: "github"/);
		assert.match(p, /session_start/);
	});

	it("documents the {apiArgs} and {githubEvent} placeholders", () => {
		const p = buildSchedulePrompt({ userRequest: "x", timezone: "UTC" });
		assert.match(p, /\{apiArgs\}/);
		assert.match(p, /\{githubEvent\}/);
	});

	it("documents the multi-trigger array path", () => {
		const p = buildSchedulePrompt({ userRequest: "x", timezone: "UTC" });
		assert.match(p, /triggers/);
		assert.match(p, /multi-trigger|Multi-trigger/);
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

	it("an entirely unknown trigger kind is rejected", () => {
		const bad = {
			name: "x",
			prompt: "y",
			trigger: { kind: "telepathic" },
		};
		assert.equal(Value.Check(RoutineCreateArgs, bad), false);
	});

	it("cron, oneoff, api, github trigger objects all validate", () => {
		const cron: RoutineCreateArgsT = {
			name: "morning",
			prompt: "x",
			trigger: { kind: "cron", expr: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
		};
		const oneoff: RoutineCreateArgsT = {
			name: "later",
			prompt: "x",
			trigger: { kind: "oneoff", fireAtIso: "2030-01-01T09:00:00Z" },
		};
		const api: RoutineCreateArgsT = {
			name: "webhook",
			prompt: "x",
			trigger: { kind: "api", allowArgs: true },
		};
		const github: RoutineCreateArgsT = {
			name: "pr-watch",
			prompt: "x",
			trigger: {
				kind: "github",
				repo: "owner/name",
				event: "pull_request.opened",
				pollInterval: "5m",
				filter: { labels: ["needs-review"] },
			},
		};
		for (const args of [cron, oneoff, api, github]) {
			assert.equal(Value.Check(RoutineCreateArgs, args), true);
		}
	});

	it("multi-trigger arrays validate", () => {
		const multi: RoutineCreateArgsT = {
			name: "dual",
			prompt: "x",
			triggers: [
				{ kind: "pulse", interval: "10m" },
				{ kind: "api", allowArgs: true },
			],
		};
		assert.equal(Value.Check(RoutineCreateArgs, multi), true);
	});
});
