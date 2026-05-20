import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";
import { scheduleRoutine, stopScheduler, unscheduleRoutine } from "../src/scheduler.ts";
import { emptyStore } from "../src/store.ts";
import type { Routine, RoutineRuntimeState } from "../src/types.ts";
import { SCHEMA_VERSION } from "../src/types.ts";

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
		assert.equal(rt.queue.filter((id) => id === routine.id).length, 1);
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

	it("schemaVersion is exported as 2", () => {
		assert.equal(SCHEMA_VERSION, 2);
	});
});
