/**
 * @file oneoff-fired.test.ts — `OneOffTrigger.fired` flag prevents reload noise.
 *
 * Before the fix:
 *   - oneoff fires, scheduler nulls the in-memory timer slot but leaves
 *     the trigger in routine.triggers as-is.
 *   - On /reload, scheduler.armTrigger calls parseOneOff, which throws
 *     ("in the past"), armTrigger catches and logs at console.error.
 *   - User sees a noisy error on every restart.
 *
 * After the fix:
 *   - Post-fire callback sets trigger.fired = true and persists.
 *   - Reload sees `fired: true` and silently returns null (no parseOneOff
 *     call, no log).
 *   - For triggers whose timestamp is in the past but were never marked
 *     fired (legacy state files), the catch path also marks them spent
 *     and persists, so subsequent reloads are silent.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME before importing modules that capture STATE_FILE.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-oneoff-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { scheduleRoutine, stopScheduler } = await import("../src/scheduler.ts");
const { emptyStore } = await import("../src/store.ts");

import type { OneOffTrigger, Routine, RoutineRuntimeState } from "../src/types.ts";

after(async () => {
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

const liveRuntimes: RoutineRuntimeState[] = [];

// Capture console.warn / console.error so we can assert the silent path.
let warns: string[] = [];
let errors: string[] = [];
const origWarn = console.warn;
const origError = console.error;

beforeEach(() => {
	warns = [];
	errors = [];
	console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
	mock.timers.enable({
		apis: ["setInterval", "setTimeout"],
		now: Date.parse("2026-06-01T00:00:00Z"),
	});
});

afterEach(() => {
	console.warn = origWarn;
	console.error = origError;
	for (const rt of liveRuntimes.splice(0)) {
		try {
			stopScheduler(rt);
		} catch {
			/* ignore */
		}
	}
	mock.timers.reset();
});

describe("oneoff — fired flag", () => {
	it("does not arm a trigger marked fired (silent reload)", () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const trigger: OneOffTrigger = {
			kind: "oneoff",
			fireAtIso: "2026-06-01T01:00:00Z",
			fired: true,
		};
		const routine: Routine = {
			id: "r1",
			name: "spent",
			prompt: "x",
			triggers: [trigger],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		rt.store.routines[routine.id] = routine;
		scheduleRoutine(routine, rt, fakePi, getCtx);
		// No timer slot recorded; no error / warn logged.
		assert.equal(rt.timers.get(routine.id), undefined);
		assert.deepEqual(warns, []);
		assert.deepEqual(errors, []);
	});

	it("marks an unfired-but-past oneoff as fired on arm (no error log)", () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const trigger: OneOffTrigger = {
			kind: "oneoff",
			fireAtIso: "2026-05-01T01:00:00Z", // ~1 month before our mocked "now"
		};
		const routine: Routine = {
			id: "r1",
			name: "legacy",
			prompt: "x",
			triggers: [trigger],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		rt.store.routines[routine.id] = routine;
		scheduleRoutine(routine, rt, fakePi, getCtx);
		assert.equal(trigger.fired, true, "past oneoff should be marked fired");
		assert.equal(rt.timers.get(routine.id), undefined);
		assert.deepEqual(errors, [], "the 'in the past' case must not log to console.error");
	});

	it("marks a oneoff as fired after its setTimeout callback runs", () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const fireAt = new Date(Date.now() + 3_600_000).toISOString();
		const trigger: OneOffTrigger = { kind: "oneoff", fireAtIso: fireAt };
		const routine: Routine = {
			id: "r1",
			name: "future",
			prompt: "x",
			triggers: [trigger],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		rt.store.routines[routine.id] = routine;
		scheduleRoutine(routine, rt, fakePi, getCtx);
		assert.equal(trigger.fired, undefined, "should not be marked fired before the time");
		// Tick past the fire time. The setTimeout callback runs synchronously
		// under mock.timers, sets fired = true, and nulls the slot.
		mock.timers.tick(3_600_001);
		assert.equal(trigger.fired, true);
		const handles = rt.timers.get(routine.id);
		assert.equal(handles?.[0], null, "slot nulled after fire");
	});
});
