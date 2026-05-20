/**
 * @file drain-paused.test.ts — drainQueue gates on routine.paused.
 *
 * Scenario the gate exists for: a routine was queued (via the scheduler
 * tick or the api server) BEFORE the user called /routine-pause. The
 * enqueue gate didn't see the pause flag because pause happened later.
 * drainQueue must drop the entry rather than fire it.
 *
 * Manual fires (origin.kind === "manual") are the exception — they're the
 * explicit override path.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { drainQueue, stopScheduler } from "../src/scheduler.ts";
import { emptyStore } from "../src/store.ts";
import { createRoutine, setPaused } from "../src/tools/_mutate.ts";
import type { RoutineRuntimeState } from "../src/types.ts";

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

const liveRuntimes: RoutineRuntimeState[] = [];

// Stub ctx that drainQueue will accept as "idle and ready".
const fakeIdleCtx = {
	cwd: "/tmp",
	hasUI: true,
	isIdle: () => true,
	hasPendingMessages: () => false,
	ui: {} as Record<string, unknown>,
} as unknown as ExtensionContext;

let sentMessages: string[] = [];
const fakePi = {
	sendUserMessage(message: string) {
		sentMessages.push(message);
	},
} as unknown as ExtensionAPI;
const getCtx = () => fakeIdleCtx;

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

describe("drainQueue — pause gate", () => {
	it("drops a paused routine from the queue without firing", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const r = await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		assert.ok(!("error" in r));
		if ("error" in r) return;
		// Queue the routine, THEN pause it (simulating: a tick raced the pause).
		rt.queue.push(r.id);
		rt.triggerOrigin.set(r.id, { index: 0, kind: "pulse" });
		await setPaused("w", true, rt);

		await drainQueue(rt, fakePi, getCtx);

		assert.equal(sentMessages.length, 0, "no message should have been sent");
		assert.equal(rt.isRoutineTurnActive, false);
		assert.equal(rt.queue.length, 0, "paused entry should have been dropped");
	});

	it("still fires a manual entry even while paused", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const r = await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		assert.ok(!("error" in r));
		if ("error" in r) return;
		rt.queue.push(r.id);
		rt.triggerOrigin.set(r.id, { index: -1, kind: "manual" });
		await setPaused("w", true, rt);

		await drainQueue(rt, fakePi, getCtx);

		assert.equal(sentMessages.length, 1, "manual fire should bypass the pause gate");
		assert.equal(rt.isRoutineTurnActive, true);
	});
});
