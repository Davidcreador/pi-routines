/**
 * @file catch-up.test.ts — bounded missed-tick catch-up at session_start.
 *
 * A routine whose cron/pulse slot passes while no interactive session is
 * live (machine asleep, pi down) used to lose the tick entirely. At the next
 * interactive session_start, `catchUpMissedTicks` enqueues ONE catch-up fire
 * per routine for the trigger with the oldest missed slot, carrying a
 * contextNote so the routine's LLM knows it is a catch-up.
 *
 * Under test: cron + pulse detection against the lastFiredAt/createdAt
 * anchor, the never-fired anchor, the pause/queued/in-flight gates,
 * one-fire-per-multi-trigger-routine, and idempotency after a real fire.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME so saveStore writes don't trample the real ~/.pi state file.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-catchup-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { catchUpMissedTicks, enqueueRoutineFire } = await import("../src/scheduler.ts");
const { emptyStore, flushStoreWrites } = await import("../src/store.ts");

import type { Routine, RoutineRuntimeState } from "../src/types.ts";

after(async () => {
	await flushStoreWrites();
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	await fs.rm(tmpHome, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

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

function makeCronRoutine(id: string, createdAt: number, expr = "0 9 * * *"): Routine {
	return {
		id,
		name: id,
		prompt: "go",
		triggers: [{ kind: "cron", expr }],
		context: "session",
		quiet: false,
		createdAt,
	};
}

function makePulseRoutine(id: string, createdAt: number, intervalMs = 30 * 60_000): Routine {
	return {
		id,
		name: id,
		prompt: "go",
		triggers: [{ kind: "pulse", intervalMs, intervalHuman: "30m" }],
		context: "session",
		quiet: false,
		createdAt,
	};
}

const idleCtx = {
	cwd: "/tmp",
	hasUI: true,
	isIdle: () => true,
	hasPendingMessages: () => false,
} as unknown as ExtensionContext;
const fakePi = { sendUserMessage() {} } as unknown as ExtensionAPI;
const getCtx = () => idleCtx;

function addRoutine(rt: RoutineRuntimeState, routine: Routine, lastFiredAt?: number): void {
	rt.store.routines[routine.id] = routine;
	rt.store.tickState[routine.id] = {
		tickCount: lastFiredAt ? 3 : 0,
		lastFiredAt: lastFiredAt ?? 0,
		lastFiredDateLocal: "",
		userState: {},
	};
}

beforeEach(async () => {
	await flushStoreWrites();
});

describe("catchUpMissedTicks", () => {
	it("enqueues a catch-up for a cron routine whose latest slot passed", () => {
		const rt = makeRuntime();
		addRoutine(rt, makeCronRoutine("daily", Date.now() - 10 * DAY), Date.now() - 2 * DAY);
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 1);
		const entry = rt.queue[0]!;
		assert.equal(entry.origin.kind, "cron");
		assert.equal(entry.origin.index, 0);
		assert.ok(entry.contextNote?.includes("Missed-tick catch-up"), "carries the explanation");
		assert.ok(entry.contextNote?.includes("last fired"), "states the anchor");
	});

	it("does not fire for a cron routine whose next slot is still in the future", () => {
		const rt = makeRuntime();
		// Fired at the top of the current hour; hourly cron → next slot < 1h away.
		const now = Date.now();
		addRoutine(rt, makeCronRoutine("hourly", now - 30 * DAY, "0 * * * *"), now - 120_000);
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0);
	});

	it("anchors on createdAt for a routine that has never fired", () => {
		const rt = makeRuntime();
		addRoutine(rt, makeCronRoutine("never", Date.now() - 3 * DAY));
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 1);
		assert.ok(rt.queue[0]!.contextNote?.includes("has never fired"));
	});

	it("does not fire for a new routine with no slot passed since creation", () => {
		const rt = makeRuntime();
		// Cron slot set 30 minutes in the future (mod the hour), so no slot
		// exists between creation (2 minutes ago) and now in either hour-ordering.
		const futureMinute = (new Date().getMinutes() + 30) % 60;
		addRoutine(rt, makeCronRoutine("fresh", Date.now() - 120_000, `${futureMinute} * * * *`));
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0);
	});

	it("enqueues a catch-up for a pulse routine after a full missed interval", () => {
		const rt = makeRuntime();
		addRoutine(rt, makePulseRoutine("pulse", Date.now() - 7 * DAY), Date.now() - 2 * HOUR);
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 1);
		assert.equal(rt.queue[0]!.origin.kind, "pulse");
	});

	it("does not fire a pulse routine inside its interval", () => {
		const rt = makeRuntime();
		addRoutine(rt, makePulseRoutine("pulse-ok", Date.now() - 7 * DAY), Date.now() - 10 * 60_000);
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0);
	});

	it("skips paused routines silently", () => {
		const rt = makeRuntime();
		addRoutine(rt, { ...makeCronRoutine("paused", Date.now() - 10 * DAY), paused: true });
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0);
		assert.equal(rt.store.tickState.paused?.runs?.length ?? 0, 0, "no skip record written");
	});

	it("skips routines already queued (rehydrated survivors win)", () => {
		const rt = makeRuntime();
		addRoutine(rt, makeCronRoutine("queued", Date.now() - 10 * DAY), Date.now() - 2 * DAY);
		enqueueRoutineFire(rt.store.routines.queued!, { index: 0, kind: "cron" }, rt, fakePi, getCtx, {
			autoDrain: false,
		});
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 1, "only the survivor entry");
		assert.equal(rt.queue[0]!.contextNote, undefined, "survivor is not re-marked");
	});

	it("skips the routine whose turn is in flight", () => {
		const rt = makeRuntime();
		addRoutine(rt, makeCronRoutine("flying", Date.now() - 10 * DAY), Date.now() - 2 * DAY);
		rt.pendingRun = {
			routineId: "flying",
			runId: "in-flight",
			triggerIndex: 0,
			triggerKind: "cron",
			startedAt: Date.now(),
			snippet: "",
			status: "success",
		};
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0);
	});

	it("fires once per multi-trigger routine, choosing the oldest missed slot", () => {
		const rt = makeRuntime();
		const routine: Routine = {
			id: "multi",
			name: "multi",
			prompt: "go",
			triggers: [
				{ kind: "pulse", intervalMs: DAY, intervalHuman: "24h" },
				{ kind: "cron", expr: "0 9 * * *" },
			],
			context: "session",
			quiet: false,
			createdAt: Date.now() - 10 * DAY,
		};
		addRoutine(rt, routine, Date.now() - 2 * DAY);
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 1, "one catch-up fire, not one per trigger");
		// A daily cron's next occurrence always lands <24h after the anchor,
		// so its missed slot is older than the 24h pulse's anchor+interval.
		assert.equal(rt.queue[0]!.origin.kind, "cron");
		assert.equal(rt.queue[0]!.origin.index, 1);
	});

	it("ignores hook/api/github/oneoff triggers", () => {
		const rt = makeRuntime();
		const routine: Routine = {
			id: "events",
			name: "events",
			prompt: "go",
			triggers: [
				{ kind: "hook", event: "agent_end" },
				{ kind: "api" },
				{
					kind: "github",
					repo: "o/r",
					event: "push",
					pollIntervalMs: 120_000,
				},
				{ kind: "oneoff", fireAtIso: new Date(Date.now() - DAY).toISOString() },
			],
			context: "session",
			quiet: false,
			createdAt: Date.now() - 10 * DAY,
		};
		addRoutine(rt, routine, Date.now() - 2 * DAY);
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0);
	});

	it("is idempotent across restarts after the catch-up actually fires", () => {
		const rt = makeRuntime();
		addRoutine(rt, makeCronRoutine("daily", Date.now() - 10 * DAY), Date.now() - 2 * DAY);
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 1);
		// Simulate the fire having run: lastFiredAt bumps to now.
		rt.queue.length = 0;
		rt.store.tickState.daily!.lastFiredAt = Date.now();
		catchUpMissedTicks(rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0, "no second catch-up after a real fire");
	});
});
