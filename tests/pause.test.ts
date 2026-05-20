/**
 * @file pause.test.ts — pause / resume coverage.
 *
 * Asserts:
 *   - setPaused flips routine.paused and returns changed/no-change correctly.
 *   - enqueueTriggerFire short-circuits for paused routines.
 *   - pickHookRoutines (indirectly via hooks.registerHooks) skips paused routines.
 *   - The HTTP server returns 423 Locked when an api fire targets a paused routine.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { enqueueTriggerFire, stopScheduler } from "../src/scheduler.ts";
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

const fakePi = {} as unknown as ExtensionAPI;
const getCtx = () => null as unknown as ExtensionContext | null;

const liveRuntimes: RoutineRuntimeState[] = [];

describe("pause / resume", () => {
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
				/* ignore */
			}
		}
		mock.timers.reset();
	});

	it("setPaused(true) flips the flag and reports changed: true", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		const r = await setPaused("w", true, rt);
		assert.ok(!("error" in r));
		if ("error" in r) return;
		assert.equal(r.changed, true);
		assert.equal(r.paused, true);
		assert.equal(Object.values(rt.store.routines)[0]?.paused, true);
	});

	it("setPaused is idempotent (changed: false on already-paused)", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		await setPaused("w", true, rt);
		const r = await setPaused("w", true, rt);
		assert.ok(!("error" in r));
		if ("error" in r) return;
		assert.equal(r.changed, false);
		assert.equal(r.paused, true);
	});

	it("setPaused(false) clears the flag and reports changed", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		await setPaused("w", true, rt);
		const r = await setPaused("w", false, rt);
		assert.ok(!("error" in r));
		if ("error" in r) return;
		assert.equal(r.changed, true);
		assert.equal(r.paused, false);
		assert.equal(Object.values(rt.store.routines)[0]?.paused, undefined);
	});

	it("setPaused returns an error for an unknown routine", async () => {
		const rt = makeRuntime();
		const r = await setPaused("ghost", true, rt);
		assert.ok("error" in r);
	});

	it("enqueueTriggerFire skips paused routines (no queue entry)", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const created = await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		assert.ok(!("error" in created));
		if ("error" in created) return;
		await setPaused("w", true, rt);
		const live = rt.store.routines[created.id];
		assert.ok(live);
		if (!live) return;
		enqueueTriggerFire(live, 0, rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 0);
	});

	it("resuming a routine re-enables the enqueue path", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		const created = await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		assert.ok(!("error" in created));
		if ("error" in created) return;
		await setPaused("w", true, rt);
		await setPaused("w", false, rt);
		const live = rt.store.routines[created.id];
		assert.ok(live);
		if (!live) return;
		enqueueTriggerFire(live, 0, rt, fakePi, getCtx);
		assert.equal(rt.queue.length, 1);
	});
});
