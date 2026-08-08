/**
 * @file drain-watchdog.test.ts — idle-watch retry timer for the fire queue.
 *
 * `drainQueue` is only invoked at enqueue-time (autoDrain), `agent_end`,
 * `session_start`, and manual commands. A fire queued while the session is
 * busy at every one of those moments used to starve indefinitely. The drain
 * watchdog re-attempts the drain on a fixed cadence while the queue is
 * non-empty. Invariant under test: watchdog armed <=> queue non-empty.
 *
 * Fake-timer note: the watchdog callback kicks an ASYNC drainQueue whose
 * fire path awaits saveStore (real fs I/O against the redirected HOME).
 * `setImmediate` is not mocked, so `flushDrain` yields the real event loop
 * until the write chain and the drain continuation have settled.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME so saveStore writes don't trample the real ~/.pi state file.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-watchdog-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { drainQueue, drainRetryMs, enqueueRoutineFire, stopScheduler } = await import(
	"../src/scheduler.ts"
);
const { emptyStore, flushStoreWrites } = await import("../src/store.ts");

import type { Routine, RoutineRuntimeState } from "../src/types.ts";

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

function makeRoutine(id: string): Routine {
	return {
		id,
		name: id,
		prompt: "go",
		triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
		context: "session",
		quiet: false,
		createdAt: 0,
	};
}

/** Stub ctx that drainQueue accepts; idle state is driven by the test. */
function makeCtx(isIdle: () => boolean): ExtensionContext {
	return {
		cwd: "/tmp",
		hasUI: true,
		isIdle,
		hasPendingMessages: () => false,
		ui: {} as Record<string, unknown>,
	} as unknown as ExtensionContext;
}

let sentMessages: string[] = [];
const fakePi = {
	sendUserMessage(message: string) {
		sentMessages.push(message);
	},
} as unknown as ExtensionAPI;

const liveRuntimes: RoutineRuntimeState[] = [];

/**
 * Let the watchdog-kicked async drain run to completion: `tick()` runs the
 * interval callback synchronously, but drainQueue's fire path awaits real
 * fs writes (saveStore), whose continuations land on the real event loop.
 */
async function flushDrain(): Promise<void> {
	await flushStoreWrites();
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

beforeEach(() => {
	sentMessages = [];
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
			/* ignore */
		}
	}
	mock.timers.reset();
});

describe("drain watchdog", () => {
	it("arms the watchdog when a fire is enqueued while the session is busy", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const routine = makeRoutine("busy-1");
		rt.store.routines[routine.id] = routine;
		const getCtx = () => makeCtx(() => false);

		enqueueRoutineFire(routine, { index: 0, kind: "pulse" }, rt, fakePi, getCtx);
		await flushDrain();

		assert.equal(sentMessages.length, 0, "busy session must not fire");
		assert.equal(rt.queue.length, 1, "fire stays queued");
		assert.ok(rt.drainWatchdog, "watchdog armed while the queue is non-empty");
	});

	it("retries while busy, then drains exactly once when the session flips idle", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		let idle = false;
		const getCtx = () => makeCtx(() => idle);
		const routine = makeRoutine("flip-1");
		rt.store.routines[routine.id] = routine;

		enqueueRoutineFire(routine, { index: 0, kind: "pulse" }, rt, fakePi, getCtx);
		await flushDrain();
		assert.ok(rt.drainWatchdog);

		// Still busy at the next watchdog tick: stays queued, stays armed.
		mock.timers.tick(drainRetryMs());
		await flushDrain();
		assert.equal(sentMessages.length, 0, "busy tick must not fire");
		assert.equal(rt.queue.length, 1, "busy tick leaves the fire queued");
		assert.ok(rt.drainWatchdog, "watchdog stays armed while work remains");

		// Flip idle: the next tick drains the queue and disarms.
		idle = true;
		mock.timers.tick(drainRetryMs());
		await flushDrain();
		assert.equal(sentMessages.length, 1, "idle tick fires exactly once");
		assert.equal(rt.queue.length, 0);
		assert.ok(!rt.drainWatchdog, "watchdog disarmed once the queue is empty");
	});

	it("re-entrant drainQueue during an in-progress drain does not double-fire", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const routine = makeRoutine("re-1");
		rt.store.routines[routine.id] = routine;
		rt.store.deferredHooks.push({
			id: "dh-1",
			routineId: "ghost",
			triggerIndex: 0,
			endedSessionId: "s-ended",
			deferredAt: Date.now(),
			endedSessionCwd: "/tmp",
			endedDateLocal: "2026-06-01",
			endedTimeLocal: "00:00",
			transcript: "t",
		});
		// Ghost entry first: its deferred-hook cleanup awaits saveStore, which
		// is the deterministic suspension point for the in-flight drain.
		rt.queue.push({
			routineId: "ghost",
			runId: "run-ghost",
			origin: { index: 0, kind: "hook" },
			deferredHookId: "dh-1",
		});
		rt.queue.push({
			routineId: routine.id,
			runId: "run-real",
			origin: { index: 0, kind: "pulse" },
		});
		const getCtx = () => makeCtx(() => true);

		const inFlight = drainQueue(rt, fakePi, getCtx);
		assert.equal(rt.draining, true, "drain is in progress (suspended in ghost cleanup)");

		// A racing drain (watchdog tick / agent_end / autoDrain) must no-op.
		await drainQueue(rt, fakePi, getCtx);
		assert.equal(sentMessages.length, 0, "re-entrant call must not fire");

		await inFlight;
		assert.equal(sentMessages.length, 1, "exactly one fire once the drain resumes");
		assert.equal(rt.queue.length, 0);
		assert.equal(rt.draining, false);
		assert.ok(!rt.drainWatchdog);
		assert.equal(rt.store.deferredHooks.length, 0, "ghost deferred hook consumed");
	});

	it("stopScheduler disarms the watchdog even with work still queued", () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const routine = makeRoutine("stop-1");
		rt.store.routines[routine.id] = routine;
		const getCtx = () => makeCtx(() => false);

		enqueueRoutineFire(routine, { index: 0, kind: "pulse" }, rt, fakePi, getCtx, {
			autoDrain: false,
		});
		assert.equal(rt.queue.length, 1);
		assert.ok(rt.drainWatchdog, "armed after enqueue");

		stopScheduler(rt);
		assert.ok(!rt.drainWatchdog, "disarmed by stopScheduler");
		assert.equal(rt.queue.length, 0);
	});

	it("deleteRoutine that empties the queue disarms the watchdog immediately", async () => {
		const { deleteRoutine } = await import("../src/tools/_mutate.ts");
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const routine = makeRoutine("del-1");
		rt.store.routines[routine.id] = routine;
		const getCtx = () => makeCtx(() => false);

		enqueueRoutineFire(routine, { index: 0, kind: "pulse" }, rt, fakePi, getCtx, {
			autoDrain: false,
		});
		assert.equal(rt.queue.length, 1);
		assert.ok(rt.drainWatchdog, "armed while the delete target sits queued");

		await deleteRoutine(routine.id, rt);
		assert.equal(rt.queue.length, 0, "delete drops the queued fire");
		assert.ok(!rt.drainWatchdog, "watchdog disarmed immediately, not at the next tick");
	});

	it("parses PI_ROUTINES_DRAIN_RETRY_MS with clamp + default", () => {
		const orig = process.env.PI_ROUTINES_DRAIN_RETRY_MS;
		try {
			process.env.PI_ROUTINES_DRAIN_RETRY_MS = "1";
			assert.equal(drainRetryMs(), 5000, "below floor clamps to 5s");
			process.env.PI_ROUTINES_DRAIN_RETRY_MS = "abc";
			assert.equal(drainRetryMs(), 60000, "unparseable falls back to 60s");
			process.env.PI_ROUTINES_DRAIN_RETRY_MS = "99999999";
			assert.equal(drainRetryMs(), 600000, "above ceiling clamps to 10min");
			delete process.env.PI_ROUTINES_DRAIN_RETRY_MS;
			assert.equal(drainRetryMs(), 60000, "unset falls back to 60s");
		} finally {
			if (orig === undefined) delete process.env.PI_ROUTINES_DRAIN_RETRY_MS;
			else process.env.PI_ROUTINES_DRAIN_RETRY_MS = orig;
		}
	});

	it("still fires immediately when the session is idle at enqueue time", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const routine = makeRoutine("idle-1");
		rt.store.routines[routine.id] = routine;
		const getCtx = () => makeCtx(() => true);

		enqueueRoutineFire(routine, { index: 0, kind: "pulse" }, rt, fakePi, getCtx);
		await flushDrain();

		assert.equal(sentMessages.length, 1, "autoDrain fires immediately when idle");
		assert.equal(rt.queue.length, 0);
		assert.ok(!rt.drainWatchdog, "drained queue leaves the watchdog disarmed");
	});
});
