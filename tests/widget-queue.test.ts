/**
 * @file widget-queue.test.ts — footer health surfacing: queue age + skip rate.
 *
 * The footer widget used to render only the routine roster; queue starvation
 * was invisible unless someone ran `/routine-runs`. The widget now appends a
 * queue-age warning while the fire queue is non-empty and a `N skips/24h`
 * counter when any routine recorded skipped runs in the trailing 24h.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const { updateWidget, startWidgetRefresh } = await import("../src/widget.ts");
const { emptyStore } = await import("../src/store.ts");

import type { Routine, RoutineQueueEntry, RoutineRun, RoutineRuntimeState } from "../src/types.ts";

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

function makeRoutine(id: string, trigger?: Routine["triggers"][number]): Routine {
	return {
		id,
		name: id,
		prompt: "go",
		triggers: [trigger ?? { kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
		context: "session",
		quiet: false,
		createdAt: 0,
	};
}

function queueEntry(routineId: string, queuedAt?: number): RoutineQueueEntry {
	return {
		routineId,
		runId: `run-${routineId}-${queuedAt ?? "x"}`,
		origin: { index: 0, kind: "cron" },
		...(queuedAt === undefined ? {} : { queuedAt }),
	};
}

function skipRun(routineId: string, startedAt: number): RoutineRun {
	return {
		id: `skip-${startedAt}`,
		routineId,
		startedAt,
		endedAt: startedAt,
		durationMs: 0,
		status: "skipped",
		triggerIndex: 0,
		triggerKind: "cron",
		snippet: "routine already queued",
		skipReason: "routine already queued",
	};
}

function makeCtx(): { ctx: ExtensionContext; statuses: Array<string | undefined> } {
	const statuses: Array<string | undefined> = [];
	const ctx = {
		cwd: "/tmp",
		hasUI: true,
		ui: {
			setStatus(_key: string, text: string | undefined) {
				statuses.push(text);
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, statuses };
}

afterEach(() => {
	mock.timers.reset();
});

describe("widget health surfacing", () => {
	it("renders the baseline roster when the queue is empty and nothing skipped", () => {
		const rt = makeRuntime();
		rt.store.routines.r1 = makeRoutine("r1");
		const { ctx, statuses } = makeCtx();
		updateWidget(rt, ctx);
		assert.equal(statuses.length, 1);
		assert.ok(!statuses[0]?.includes("queued"), "no queue segment");
		assert.ok(!statuses[0]?.includes("skips"), "no skip segment");
	});

	it("shows queue depth and the oldest entry's age", () => {
		const rt = makeRuntime();
		rt.store.routines.r1 = makeRoutine("r1");
		const now = Date.now();
		rt.queue.push(
			queueEntry("r1", now - 5 * 60_000),
			queueEntry("r1", now - 45 * 60_000),
			queueEntry("r1", now - 20 * 60_000),
		);
		const { ctx, statuses } = makeCtx();
		updateWidget(rt, ctx);
		assert.ok(statuses[0]?.includes("⚠ 3 queued, oldest 45m"), `oldest age wins: ${statuses[0]}`);
	});

	it("shows queue depth without an age when no entry carries a timestamp", () => {
		const rt = makeRuntime();
		rt.store.routines.r1 = makeRoutine("r1");
		rt.queue.push(queueEntry("r1"), queueEntry("r1"));
		const { ctx, statuses } = makeCtx();
		updateWidget(rt, ctx);
		assert.ok(statuses[0]?.includes("⚠ 2 queued"), `count only: ${statuses[0]}`);
		assert.ok(!statuses[0]?.includes("oldest"), "no fabricated age");
	});

	it("compacts ages to hours and days", () => {
		const rt = makeRuntime();
		rt.store.routines.r1 = makeRoutine("r1");
		const { ctx, statuses } = makeCtx();
		rt.queue.push(queueEntry("r1", Date.now() - 3 * 60 * 60_000));
		updateWidget(rt, ctx);
		assert.ok(statuses[0]?.includes("oldest 3h"), `${statuses[0]}`);
		rt.queue[0] = queueEntry("r1", Date.now() - 26 * 60 * 60_000);
		updateWidget(rt, ctx);
		assert.ok(statuses[1]?.includes("oldest 1d"), `${statuses[1]}`);
	});

	it("counts skipped runs in the trailing 24h only", () => {
		const rt = makeRuntime();
		rt.store.routines.r1 = makeRoutine("r1");
		rt.store.routines.r2 = makeRoutine("r2");
		const now = Date.now();
		rt.store.tickState.r1 = {
			tickCount: 5,
			lastFiredAt: now,
			lastFiredDateLocal: "2026-08-11",
			userState: {},
			runs: [
				skipRun("r1", now - 60_000),
				skipRun("r1", now - 25 * 60 * 60_000), // outside the window
				{ ...skipRun("r1", now - 30_000), status: "success", skipReason: undefined },
			],
		};
		rt.store.tickState.r2 = {
			tickCount: 1,
			lastFiredAt: now,
			lastFiredDateLocal: "2026-08-11",
			userState: {},
			runs: [skipRun("r2", now - 2 * 60 * 60_000)],
		};
		const { ctx, statuses } = makeCtx();
		updateWidget(rt, ctx);
		assert.ok(statuses[0]?.includes("2 skips/24h"), `in-window skips only: ${statuses[0]}`);
	});

	it("combines queue and skip segments", () => {
		const rt = makeRuntime();
		rt.store.routines.r1 = makeRoutine("r1");
		rt.queue.push(queueEntry("r1", Date.now() - 10 * 60_000));
		rt.store.tickState.r1 = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
			runs: [skipRun("r1", Date.now())],
		};
		const { ctx, statuses } = makeCtx();
		updateWidget(rt, ctx);
		assert.ok(statuses[0]?.includes("⚠ 1 queued, oldest 10m"), `${statuses[0]}`);
		assert.ok(statuses[0]?.includes("1 skips/24h"), `${statuses[0]}`);
	});

	it("stays silent in headless sessions", () => {
		const rt = makeRuntime();
		rt.store.routines.r1 = makeRoutine("r1");
		rt.queue.push(queueEntry("r1", Date.now() - 60_000));
		const { ctx, statuses } = makeCtx();
		(ctx as { hasUI: boolean }).hasUI = false;
		updateWidget(rt, ctx);
		assert.equal(statuses.length, 0);
	});

	it("starts the refresh interval for a non-empty queue even without timed routines", () => {
		mock.timers.enable({ apis: ["setInterval"], now: Date.now() });
		const rt = makeRuntime();
		rt.store.routines.h1 = makeRoutine("h1", { kind: "hook", event: "agent_end" });
		rt.queue.push(queueEntry("h1", Date.now() - 60_000));
		const { ctx, statuses } = makeCtx();
		updateWidget(rt, ctx);
		const stop = startWidgetRefresh(rt, () => ctx);
		try {
			const before = statuses.length;
			mock.timers.tick(10_000);
			assert.ok(statuses.length > before, "interval ticks while work starves");
			assert.ok(statuses[statuses.length - 1]?.includes("queued"));
		} finally {
			stop();
		}
	});

	it("does not start the refresh interval for an empty queue without timed routines", () => {
		mock.timers.enable({ apis: ["setInterval"], now: Date.now() });
		const rt = makeRuntime();
		rt.store.routines.h1 = makeRoutine("h1", { kind: "hook", event: "agent_end" });
		const { ctx, statuses } = makeCtx();
		const stop = startWidgetRefresh(rt, () => ctx);
		try {
			mock.timers.tick(60_000);
			assert.equal(statuses.length, 0, "no interval, no ticks");
		} finally {
			stop();
		}
	});
});
