/**
 * @file max-runs-per-day.test.ts — soft daily cap.
 *
 * `fireRoutine` is the gate. We invoke it directly with a stub pi/ctx so
 * we can observe (a) the bump of `tickState.runsToday`, (b) the skipped
 * run recorded when the cap is reached, and (c) the day-rollover that
 * resets the counter to 0 at local midnight.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME so saveStore writes to a temp dir. We must do this BEFORE
// importing modules that capture STATE_FILE at module load.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-cap-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { fireRoutine } = await import("../src/executor.ts");
const { emptyStore, flushStoreWrites } = await import("../src/store.ts");

import type { Routine, RoutineRuntimeState } from "../src/types.ts";

// Restore HOME and remove the temp dir when this test file's suites finish.
// Previous version used `process.on("exit", () => require(...))` which is a
// no-op in ESM (`require` is undefined; the try/catch swallowed the
// ReferenceError), leaking the temp dir at process exit.
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

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
	return {
		id: "r1",
		name: "r1",
		prompt: "hello",
		triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
		context: "session",
		quiet: false,
		createdAt: 0,
		...overrides,
	};
}

// Stubs — fireRoutine only calls `pi.sendUserMessage` on the success path.
let lastSentMessage: string | null = null;
const fakePi = {
	sendUserMessage(message: string) {
		lastSentMessage = message;
	},
} as unknown as ExtensionAPI;
const fakeCtx = { cwd: "/tmp" } as unknown as ExtensionContext;

beforeEach(() => {
	lastSentMessage = null;
});

afterEach(() => {
	mock.timers.reset();
});

describe("fireRoutine — maxRunsPerDay", () => {
	it("allows the first N fires, then records a skipped run for the (N+1)th", async () => {
		const rt = makeRuntime();
		const routine = makeRoutine({ maxRunsPerDay: 2 });
		rt.store.routines[routine.id] = routine;
		rt.store.tickState[routine.id] = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};

		// First fire — succeeds, increments runsToday → 1.
		await fireRoutine(routine, rt, rt.store, fakePi, fakeCtx);
		assert.equal(rt.store.tickState[routine.id]?.runsToday, 1);
		assert.equal(rt.isRoutineTurnActive, true);
		// Caller (hooks.agent_end) normally releases the guard; here we
		// mimic it so the next fire can acquire.
		rt.isRoutineTurnActive = false;
		rt.activeRoutineName = null;
		rt.pendingRun = null;

		// Second fire — succeeds, runsToday → 2.
		await fireRoutine(routine, rt, rt.store, fakePi, fakeCtx);
		assert.equal(rt.store.tickState[routine.id]?.runsToday, 2);
		rt.isRoutineTurnActive = false;
		rt.activeRoutineName = null;
		rt.pendingRun = null;

		// Third fire — capped. No guard acquisition, no message sent.
		lastSentMessage = null;
		await fireRoutine(routine, rt, rt.store, fakePi, fakeCtx);
		assert.equal(rt.isRoutineTurnActive, false);
		assert.equal(lastSentMessage, null);
		const runs = rt.store.tickState[routine.id]?.runs ?? [];
		const lastRun = runs[runs.length - 1];
		assert.equal(lastRun?.status, "skipped");
		assert.equal(lastRun?.skipReason, "daily cap reached");
	});

	it("rolls the counter over to 0 at local midnight", async () => {
		const rt = makeRuntime();
		const routine = makeRoutine({ maxRunsPerDay: 1 });
		rt.store.routines[routine.id] = routine;
		// Seed yesterday's counter at the cap.
		rt.store.tickState[routine.id] = {
			tickCount: 1,
			lastFiredAt: Date.now() - 86_400_000,
			lastFiredDateLocal: "2026-05-19",
			userState: {},
			runsToday: 1,
			runsTodayDate: "2026-05-19",
		};
		// Today is a different date — fire should succeed and counter
		// should reset to 1.
		await fireRoutine(routine, rt, rt.store, fakePi, fakeCtx);
		const today = new Date().toLocaleDateString("en-CA");
		assert.equal(rt.store.tickState[routine.id]?.runsToday, 1);
		assert.equal(rt.store.tickState[routine.id]?.runsTodayDate, today);
	});

	it("manual fires bypass the daily cap", async () => {
		const rt = makeRuntime();
		const routine = makeRoutine({ maxRunsPerDay: 1 });
		rt.store.routines[routine.id] = routine;
		const today = new Date().toLocaleDateString("en-CA");
		rt.store.tickState[routine.id] = {
			tickCount: 1,
			lastFiredAt: Date.now() - 60_000,
			lastFiredDateLocal: today,
			userState: {},
			runsToday: 1,
			runsTodayDate: today,
		};
		// Mark the next fire as manual.
		rt.triggerOrigin.set(routine.id, { index: -1, kind: "manual" });
		await fireRoutine(routine, rt, rt.store, fakePi, fakeCtx);
		// Manual fire goes through — message was sent and guard was acquired.
		assert.notEqual(lastSentMessage, null);
		assert.equal(rt.isRoutineTurnActive, true);
	});

	it("manual fires do NOT increment runsToday (cap is for automatic fires)", async () => {
		const rt = makeRuntime();
		const routine = makeRoutine({ maxRunsPerDay: 3 });
		rt.store.routines[routine.id] = routine;
		const today = new Date().toLocaleDateString("en-CA");
		rt.store.tickState[routine.id] = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
			runsToday: 0,
			runsTodayDate: today,
		};
		rt.triggerOrigin.set(routine.id, { index: -1, kind: "manual" });
		await fireRoutine(routine, rt, rt.store, fakePi, fakeCtx);
		// tickCount still bumps (every fire counts toward maxTicks), but
		// runsToday stays at 0 so the cap remains untouched.
		assert.equal(rt.store.tickState[routine.id]?.tickCount, 1);
		assert.equal(rt.store.tickState[routine.id]?.runsToday, 0);
	});

	it("no cap field → no enforcement (current behaviour preserved)", async () => {
		const rt = makeRuntime();
		const routine = makeRoutine(); // no maxRunsPerDay
		rt.store.routines[routine.id] = routine;
		rt.store.tickState[routine.id] = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};
		for (let i = 0; i < 5; i++) {
			await fireRoutine(routine, rt, rt.store, fakePi, fakeCtx);
			rt.isRoutineTurnActive = false;
			rt.activeRoutineName = null;
			rt.pendingRun = null;
		}
		assert.equal(rt.store.tickState[routine.id]?.runsToday, 5);
	});
});
