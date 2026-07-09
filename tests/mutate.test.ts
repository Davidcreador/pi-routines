/**
 * @file mutate.test.ts — tests for `createRoutine` / `resolveTrigger` covering
 * every trigger kind, multi-trigger arrays, and the new invariants
 * (`MAX_TRIGGERS_PER_ROUTINE`, single-routine `agent_end` uniqueness,
 * intra-routine `agent_end` uniqueness, `maxRunsPerDay` field).
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME BEFORE importing modules so STATE_FILE resolves to the
// temp dir. Without this, createRoutine -> saveStore would write to the
// user's real ~/.pi/agent/extensions/routines/state.json and trample
// any routines they actually have configured.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-mutate-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { stopScheduler } = await import("../src/scheduler.ts");
const { emptyStore, flushStoreWrites } = await import("../src/store.ts");
const { createRoutine, resolveTrigger } = await import("../src/tools/_mutate.ts");

import type { RoutineRuntimeState } from "../src/types.ts";

after(async () => {
	await flushStoreWrites();
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	await fs.rm(tmpHome, { recursive: true, force: true });
});

function makeRuntime(): RoutineRuntimeState {
	return {
		store: emptyStore(),
		timers: new Map(),
		queue: [],
		isRoutineTurnActive: false,
		activeRoutineName: null,
		lastUiCtx: null,
		triggerOrigin: new Map(),
		pendingRun: null,
	};
}

const fakePi = {} as unknown as ExtensionAPI;
const getCtx = () => null as unknown as ExtensionContext | null;

// Track every runtime that called createRoutine so we can stopScheduler
// in afterEach (real setInterval handles would keep the process alive).
const liveRuntimes: RoutineRuntimeState[] = [];

function track<T extends RoutineRuntimeState>(rt: T): T {
	liveRuntimes.push(rt);
	return rt;
}

describe("resolveTrigger — every kind", () => {
	it("pulse: human interval → ms + canonical human form", () => {
		const t = resolveTrigger({ kind: "pulse", interval: "1h30m" });
		assert.equal(t.kind, "pulse");
		if (t.kind === "pulse") {
			assert.equal(t.intervalMs, 5_400_000);
			assert.equal(t.intervalHuman, "1h30m");
		}
	});

	it("pulse: rejects too-short interval", () => {
		assert.throws(() => resolveTrigger({ kind: "pulse", interval: "10s" }), /at least 30 seconds/);
	});

	it("pulse: rejects ignored timezone configuration", () => {
		assert.throws(
			() => resolveTrigger({ kind: "pulse", interval: "1m", timezone: "UTC" }),
			/do not support timezone/,
		);
	});

	it("cron: accepts well-formed expression", () => {
		const t = resolveTrigger({ kind: "cron", expr: "0 9 * * 1-5" });
		assert.equal(t.kind, "cron");
		if (t.kind === "cron") assert.equal(t.expr, "0 9 * * 1-5");
	});

	it("cron: rejects 6-field (seconds) form", () => {
		assert.throws(() => resolveTrigger({ kind: "cron", expr: "0 0 9 * * 1-5" }), /5 fields/);
	});

	it("cron and oneoff reject invalid IANA timezones", () => {
		assert.throws(
			() => resolveTrigger({ kind: "cron", expr: "0 9 * * *", timezone: "Not/A_Zone" }),
			/Invalid IANA timezone/,
		);
		assert.throws(
			() =>
				resolveTrigger({
					kind: "oneoff",
					fireAtIso: "2099-01-01T09:00:00",
					timezone: "Not/A_Zone",
				}),
			/Invalid IANA timezone/,
		);
	});

	it("oneoff: accepts a future ISO timestamp", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const t = resolveTrigger({ kind: "oneoff", fireAtIso: future });
		assert.equal(t.kind, "oneoff");
	});

	it("oneoff: rejects a past timestamp", () => {
		const past = new Date(Date.now() - 60 * 60_000).toISOString();
		assert.throws(() => resolveTrigger({ kind: "oneoff", fireAtIso: past }), /in the past/);
	});

	it("hook: passes through event + once", () => {
		const t = resolveTrigger({ kind: "hook", event: "session_start", once: "daily" });
		assert.equal(t.kind, "hook");
		if (t.kind === "hook") {
			assert.equal(t.event, "session_start");
			assert.equal(t.once, "daily");
		}
	});

	it("api: allowArgs defaults off", () => {
		const t = resolveTrigger({ kind: "api" });
		assert.equal(t.kind, "api");
		if (t.kind === "api") assert.equal(t.allowArgs, undefined);
	});

	it("api: allowArgs: true preserved", () => {
		const t = resolveTrigger({ kind: "api", allowArgs: true });
		assert.equal(t.kind, "api");
		if (t.kind === "api") assert.equal(t.allowArgs, true);
	});

	it("github: requires owner/name", () => {
		assert.throws(
			() => resolveTrigger({ kind: "github", repo: "no-slash", event: "pull_request.opened" }),
			/owner\/name/,
		);
		assert.throws(
			() =>
				resolveTrigger({
					kind: "github",
					repo: "owner/repo/extra",
					event: "pull_request.opened",
				}),
			/owner\/name/,
		);
	});

	it("github: validates filters against the event kind", () => {
		assert.throws(
			() =>
				resolveTrigger({
					kind: "github",
					repo: "a/b",
					event: "issues.opened",
					filter: { branches: ["main"] },
				}),
			/only valid for push/,
		);
		assert.throws(
			() =>
				resolveTrigger({
					kind: "github",
					repo: "a/b",
					event: "push",
					filter: { labels: ["bug"] },
				}),
			/only valid for pull_request/,
		);
	});

	it("github: clamps pollInterval to >= MIN_GITHUB_POLL_MS (60s)", () => {
		const t = resolveTrigger({
			kind: "github",
			repo: "a/b",
			event: "pull_request.opened",
			pollInterval: "30s",
		});
		assert.equal(t.kind, "github");
		if (t.kind === "github") assert.equal(t.pollIntervalMs, 60_000);
	});

	it("github: uses parsed pollInterval when above the floor", () => {
		const t = resolveTrigger({
			kind: "github",
			repo: "a/b",
			event: "push",
			pollInterval: "5m",
		});
		assert.equal(t.kind, "github");
		if (t.kind === "github") assert.equal(t.pollIntervalMs, 300_000);
	});
});

describe("createRoutine — multi-trigger + validation", () => {
	beforeEach(() => {
		mock.timers.enable({
			apis: ["setInterval", "setTimeout"],
			now: Date.parse("2026-06-01T00:00:00Z"),
		});
	});

	afterEach(() => {
		for (const rt of liveRuntimes.splice(0)) {
			try {
				stopScheduler(rt);
			} catch {
				/* tear-down best effort */
			}
		}
		mock.timers.reset();
	});

	it("creates a routine with a single pulse trigger", async () => {
		const rt = track(makeRuntime());
		const r = await createRoutine(
			{ name: "watcher", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		assert.equal("error" in r, false);
		if ("error" in r) return;
		assert.equal(r.updated, false);
		assert.equal(rt.store.routines[r.id]?.triggers.length, 1);
	});

	it("rejects an empty or whitespace-only prompt", async () => {
		const rt = track(makeRuntime());
		const result = await createRoutine(
			{ name: "blank", prompt: "   ", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		assert.ok("error" in result);
		assert.match("error" in result ? result.error : "", /Prompt must contain/);
	});

	it("creates a routine with multiple triggers (pulse + api)", async () => {
		const rt = track(makeRuntime());
		const r = await createRoutine(
			{
				name: "dual",
				prompt: "x",
				triggers: [
					{ kind: "pulse", interval: "5m" },
					{ kind: "api", allowArgs: true },
				],
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.equal("error" in r, false);
		if ("error" in r) return;
		const stored = rt.store.routines[r.id];
		assert.equal(stored?.triggers.length, 2);
		assert.equal(stored?.triggers[0]?.kind, "pulse");
		assert.equal(stored?.triggers[1]?.kind, "api");
	});

	it("singular `trigger` + array `triggers` concat to a single list", async () => {
		const rt = track(makeRuntime());
		const r = await createRoutine(
			{
				name: "mix",
				prompt: "x",
				trigger: { kind: "pulse", interval: "5m" },
				triggers: [{ kind: "api" }],
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.equal("error" in r, false);
		if ("error" in r) return;
		assert.equal(rt.store.routines[r.id]?.triggers.length, 2);
	});

	it("rejects when neither trigger nor triggers is supplied", async () => {
		const rt = track(makeRuntime());
		const r = await createRoutine({ name: "empty", prompt: "x" }, rt, fakePi, getCtx);
		assert.ok("error" in r);
		if ("error" in r) assert.match(r.error, /at least one trigger/i);
	});

	it("rejects > 4 triggers per routine", async () => {
		const rt = track(makeRuntime());
		const r = await createRoutine(
			{
				name: "many",
				prompt: "x",
				triggers: [
					{ kind: "pulse", interval: "1m" },
					{ kind: "pulse", interval: "2m" },
					{ kind: "pulse", interval: "3m" },
					{ kind: "pulse", interval: "4m" },
					{ kind: "api" },
				],
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.ok("error" in r);
		if ("error" in r) assert.match(r.error, /max is 4/i);
	});

	it("rejects two agent_end triggers on the same routine", async () => {
		const rt = track(makeRuntime());
		const r = await createRoutine(
			{
				name: "double-end",
				prompt: "x",
				triggers: [
					{ kind: "hook", event: "agent_end" },
					{ kind: "hook", event: "agent_end" },
				],
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.ok("error" in r);
		if ("error" in r) assert.match(r.error, /more than one agent_end/);
	});

	it("preserves global agent_end uniqueness across routines", async () => {
		const rt = track(makeRuntime());
		const a = await createRoutine(
			{
				name: "first-end",
				prompt: "x",
				trigger: { kind: "hook", event: "agent_end" },
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.equal("error" in a, false);
		const b = await createRoutine(
			{
				name: "second-end",
				prompt: "y",
				trigger: { kind: "hook", event: "agent_end" },
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.ok("error" in b);
		if ("error" in b) assert.match(b.error, /already uses the agent_end hook/);
	});

	it("preserves id and tickState on update by name", async () => {
		const rt = track(makeRuntime());
		const first = await createRoutine(
			{ name: "stable", prompt: "v1", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		assert.equal("error" in first, false);
		if ("error" in first) return;
		// Mutate tickState to confirm it's preserved.
		const ts = rt.store.tickState[first.id];
		if (ts) {
			ts.tickCount = 7;
			ts.userState = { sentinel: 42 };
		}
		const second = await createRoutine(
			{
				name: "stable",
				prompt: "v2",
				trigger: { kind: "pulse", interval: "2m" },
				maxRunsPerDay: 5,
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.equal("error" in second, false);
		if ("error" in second) return;
		assert.equal(second.id, first.id);
		assert.equal(second.updated, true);
		assert.equal(rt.store.routines[second.id]?.prompt, "v2");
		assert.equal(rt.store.routines[second.id]?.maxRunsPerDay, 5);
		assert.equal(rt.store.tickState[second.id]?.tickCount, 7);
		assert.equal(rt.store.tickState[second.id]?.userState.sentinel, 42);
	});

	it("validates each trigger and surfaces position in the error", async () => {
		const rt = track(makeRuntime());
		const r = await createRoutine(
			{
				name: "bad-cron",
				prompt: "x",
				triggers: [
					{ kind: "pulse", interval: "1m" },
					{ kind: "cron", expr: "not a cron" },
				],
			},
			rt,
			fakePi,
			getCtx,
		);
		assert.ok("error" in r);
		if ("error" in r) assert.match(r.error, /trigger #2/);
	});
});
