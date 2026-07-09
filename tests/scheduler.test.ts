import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-scheduler-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { enqueueRoutineFire, scheduleRoutine, stopScheduler, unscheduleRoutine } = await import(
	"../src/scheduler.ts"
);
const { emptyStore, flushStoreWrites } = await import("../src/store.ts");
const { SCHEMA_VERSION } = await import("../src/types.ts");

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

function fakePi(): unknown {
	return {};
}
function fakeCtx(): unknown {
	// drainQueue calls getCtx() and checks ctx.isIdle / hasPendingMessages.
	// We return null so drainQueue exits early without firing anything —
	// the queue itself is what we assert against.
	return null;
}

describe("scheduler — multi-trigger arming", () => {
	it("arms one timer per trigger", () => {
		mock.timers.enable({
			apis: ["setInterval", "setTimeout"],
			now: Date.parse("2026-06-01T00:00:00Z"),
		});
		const rt = makeRuntime();
		const routine: Routine = {
			id: "r1",
			name: "two-pulses",
			prompt: "go",
			triggers: [
				{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" },
				{ kind: "pulse", intervalMs: 120_000, intervalHuman: "2m" },
			],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		rt.store.routines[routine.id] = routine;
		// biome-ignore lint/suspicious/noExplicitAny: test scaffold
		scheduleRoutine(routine, rt, fakePi() as any, () => fakeCtx() as any);
		const handles = rt.timers.get(routine.id);
		assert.ok(handles);
		assert.equal(handles?.length, 2);
		stopScheduler(rt);
		mock.timers.reset();
	});

	it("multi-trigger fires within COLLAPSE_MS dedup to one enqueue", () => {
		mock.timers.enable({
			apis: ["setInterval", "setTimeout"],
			now: Date.parse("2026-06-01T00:00:00Z"),
		});
		const rt = makeRuntime();
		const routine: Routine = {
			id: "r2",
			name: "dual",
			prompt: "go",
			triggers: [
				{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" },
				{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" },
			],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		rt.store.routines[routine.id] = routine;
		// biome-ignore lint/suspicious/noExplicitAny: test scaffold
		scheduleRoutine(routine, rt, fakePi() as any, () => fakeCtx() as any);

		// Advance to fire both pulse triggers (they share the same interval).
		mock.timers.tick(60_000);

		// Both fired ~simultaneously → only one enqueue.
		assert.equal(rt.queue.filter((entry) => entry.routineId === routine.id).length, 1);
		assert.equal(
			rt.store.tickState[routine.id]?.runs?.at(-1)?.skipReason,
			"collapsed duplicate trigger",
		);
		stopScheduler(rt);
		mock.timers.reset();
	});

	it("unscheduleRoutine clears all timers for the routine", () => {
		mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		const rt = makeRuntime();
		const routine: Routine = {
			id: "r3",
			name: "multi",
			prompt: "go",
			triggers: [
				{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" },
				{ kind: "pulse", intervalMs: 90_000, intervalHuman: "1m30s" },
			],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		rt.store.routines[routine.id] = routine;
		// biome-ignore lint/suspicious/noExplicitAny: test scaffold
		scheduleRoutine(routine, rt, fakePi() as any, () => fakeCtx() as any);
		assert.equal(rt.timers.get(routine.id)?.length, 2);
		unscheduleRoutine(routine.id, rt);
		assert.equal(rt.timers.get(routine.id), undefined);
		mock.timers.reset();
	});

	it("arms a one-off + pulse pair with two slots", () => {
		const rt = makeRuntime();
		const fireAt = new Date(Date.now() + 3_600_000).toISOString();
		const routine: Routine = {
			id: "r4",
			name: "once",
			prompt: "go",
			triggers: [
				{ kind: "oneoff", fireAtIso: fireAt },
				{ kind: "pulse", intervalMs: 300_000, intervalHuman: "5m" },
			],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		rt.store.routines[routine.id] = routine;
		// biome-ignore lint/suspicious/noExplicitAny: test scaffold
		scheduleRoutine(routine, rt, fakePi() as any, () => fakeCtx() as any);
		const handles = rt.timers.get(routine.id);
		assert.equal(handles?.length, 2);
		assert.ok(handles?.[0]); // one-off armed
		assert.ok(handles?.[1]); // pulse armed
		stopScheduler(rt);
	});

	it("schemaVersion is exported as 3", () => {
		assert.equal(SCHEMA_VERSION, 3);
	});

	it("records the oldest fire as skipped when queue backpressure evicts it", () => {
		const rt = makeRuntime();
		const routines = Array.from(
			{ length: 4 },
			(_, index): Routine => ({
				id: `q${index}`,
				name: `queue-${index}`,
				prompt: "go",
				triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
				context: "session",
				quiet: false,
				createdAt: index,
			}),
		);
		for (const routine of routines) {
			rt.store.routines[routine.id] = routine;
			enqueueRoutineFire(routine, { index: 0, kind: "pulse" }, rt, fakePi() as never, () => null, {
				autoDrain: false,
			});
		}

		assert.deepEqual(
			rt.queue.map((entry) => entry.routineId),
			["q1", "q2", "q3"],
		);
		assert.equal(rt.store.tickState.q0?.runs?.at(-1)?.skipReason, "queue overflow");
		stopScheduler(rt);
	});

	it("places deferred shutdown work ahead of normal queued fires", () => {
		const rt = makeRuntime();
		const routines = ["normal-a", "normal-b", "deferred"].map(
			(id, index): Routine => ({
				id,
				name: id,
				prompt: "go",
				triggers: [{ kind: "hook", event: "session_shutdown" }],
				context: "session",
				quiet: false,
				createdAt: index,
			}),
		);
		for (const routine of routines) rt.store.routines[routine.id] = routine;
		for (const routine of routines.slice(0, 2)) {
			enqueueRoutineFire(routine, { index: 0, kind: "hook" }, rt, fakePi() as never, () => null, {
				autoDrain: false,
			});
		}
		const deferred = routines[2];
		assert.ok(deferred);
		enqueueRoutineFire(deferred, { index: 0, kind: "hook" }, rt, fakePi() as never, () => null, {
			autoDrain: false,
			priority: true,
			deferredHookId: "deferred-1",
		});

		assert.deepEqual(
			rt.queue.map((entry) => entry.routineId),
			["deferred", "normal-a", "normal-b"],
		);
		stopScheduler(rt);
	});
});
