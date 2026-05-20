/**
 * @file run-history.test.ts — covers the TP-009 run-record ring buffer.
 *
 * Synthetic scenario: call `recordRun` directly against a runtime/store to
 * verify trim semantics, status classification, and the manual-fire path's
 * `triggerKind: "manual"` widening. Avoids spinning up a fake ExtensionAPI;
 * the executor's `fireRoutine` is unit-covered by the existing scheduler /
 * suppressor suites — here we focus on the recording contract.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { recordRun, truncateSnippet } from "../src/executor.ts";
import { emptyStore } from "../src/store.ts";
import type { Routine, RoutineRun, RoutineRuntimeState } from "../src/types.ts";
import { MAX_RUN_HISTORY } from "../src/types.ts";

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

function seedRoutine(rt: RoutineRuntimeState, id = "r1"): Routine {
	const routine: Routine = {
		id,
		name: `routine-${id}`,
		prompt: "go",
		triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
		context: "session",
		quiet: false,
		createdAt: 0,
	};
	rt.store.routines[id] = routine;
	rt.store.tickState[id] = {
		tickCount: 0,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
		runs: [],
	};
	return routine;
}

function makeRun(routineId: string, n: number, partial: Partial<RoutineRun> = {}): RoutineRun {
	return {
		id: `run-${n}`,
		routineId,
		startedAt: 1_700_000_000_000 + n * 1000,
		endedAt: 1_700_000_000_000 + n * 1000 + 500,
		durationMs: 500,
		status: "success",
		triggerIndex: 0,
		triggerKind: "pulse",
		snippet: `run ${n}`,
		...partial,
	};
}

describe("run-history: ring buffer", () => {
	it("appends a run and persists into tickState.runs", () => {
		const rt = makeRuntime();
		const routine = seedRoutine(rt);
		recordRun(rt, rt.store, makeRun(routine.id, 1));
		const runs = rt.store.tickState[routine.id]?.runs ?? [];
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.snippet, "run 1");
	});

	it("trims to MAX_RUN_HISTORY entries, newest last", () => {
		const rt = makeRuntime();
		const routine = seedRoutine(rt);
		for (let i = 0; i < MAX_RUN_HISTORY + 5; i++) {
			recordRun(rt, rt.store, makeRun(routine.id, i));
		}
		const runs = rt.store.tickState[routine.id]?.runs ?? [];
		assert.equal(runs.length, MAX_RUN_HISTORY);
		// Oldest dropped — first entry should be run 5 (i.e. 0..4 evicted).
		assert.equal(runs[0]?.snippet, "run 5");
		assert.equal(runs[runs.length - 1]?.snippet, `run ${MAX_RUN_HISTORY + 4}`);
	});

	it("preserves status classification (success / error / silent / skipped)", () => {
		const rt = makeRuntime();
		const routine = seedRoutine(rt);
		recordRun(rt, rt.store, makeRun(routine.id, 1, { status: "success" }));
		recordRun(rt, rt.store, makeRun(routine.id, 2, { status: "error", snippet: "boom" }));
		recordRun(rt, rt.store, makeRun(routine.id, 3, { status: "silent", snippet: "[~]" }));
		recordRun(rt, rt.store, makeRun(routine.id, 4, { status: "skipped" }));
		const runs = rt.store.tickState[routine.id]?.runs ?? [];
		assert.deepEqual(
			runs.map((r) => r.status),
			["success", "error", "silent", "skipped"],
		);
	});

	it('records manual fires with triggerKind="manual" and triggerIndex=-1', () => {
		const rt = makeRuntime();
		const routine = seedRoutine(rt);
		recordRun(rt, rt.store, makeRun(routine.id, 1, { triggerKind: "manual", triggerIndex: -1 }));
		const last = rt.store.tickState[routine.id]?.runs?.at(-1);
		assert.equal(last?.triggerKind, "manual");
		assert.equal(last?.triggerIndex, -1);
	});

	it("ignores records for unknown routines (no tickState entry)", () => {
		const rt = makeRuntime();
		// no seedRoutine
		recordRun(rt, rt.store, makeRun("ghost", 1));
		assert.equal(rt.store.tickState.ghost, undefined);
	});
});

describe("run-history: snippet truncation", () => {
	it("collapses whitespace and trims", () => {
		assert.equal(truncateSnippet("  hello \n   world  "), "hello world");
	});

	it("caps at 200 chars and appends an ellipsis", () => {
		const long = "x".repeat(500);
		const out = truncateSnippet(long);
		assert.equal(out.length, 200);
		assert.ok(out.endsWith("\u2026"));
	});

	it("leaves short input alone", () => {
		assert.equal(truncateSnippet("ok"), "ok");
	});
});

describe("run-history: synthetic fire-twice scenario", () => {
	it("two runs appended in order with monotonic timestamps", () => {
		const rt = makeRuntime();
		const routine = seedRoutine(rt);
		const r1 = makeRun(routine.id, 1, { startedAt: 1000, endedAt: 1500, durationMs: 500 });
		const r2 = makeRun(routine.id, 2, { startedAt: 2000, endedAt: 2750, durationMs: 750 });
		recordRun(rt, rt.store, r1);
		recordRun(rt, rt.store, r2);
		const runs = rt.store.tickState[routine.id]?.runs ?? [];
		assert.equal(runs.length, 2);
		assert.ok((runs[0]?.startedAt ?? 0) < (runs[1]?.startedAt ?? 0));
		assert.equal(runs[1]?.durationMs, 750);
	});
});
