/**
 * @file queue-persistence.test.ts — queued fires survive session teardown.
 *
 * `runtime.queue` used to be purely in-memory: any fire queued when the
 * process exited was lost (only deferred shutdown hooks survived). The queue
 * now mirrors into `store.pendingQueue` on every mutation and re-enqueues
 * via `rehydrateQueuedFires` at the next interactive session_start.
 *
 * Under test: the write-through mirror (enqueue / overflow drop / drain
 * shift), teardown survival (stopScheduler no longer drop-audits), and the
 * rehydrate gate decisions (expiry, paused, session_start-hook supersede,
 * single-fire dedup vs api/github stacking).
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME so saveStore writes don't trample the real ~/.pi state file.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-queue-persist-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { drainQueue, enqueueRoutineFire, persistQueue, rehydrateQueuedFires, stopScheduler } =
	await import("../src/scheduler.ts");
const { emptyStore, flushStoreWrites, loadStore, saveStore } = await import("../src/store.ts");

import type { Routine, RoutineQueueEntry, RoutineRuntimeState } from "../src/types.ts";
import { MAX_QUEUE_DEPTH, MAX_QUEUED_FIRE_AGE_MS } from "../src/types.ts";

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

function makeHookRoutine(id: string): Routine {
	return {
		id,
		name: id,
		prompt: "go",
		triggers: [{ kind: "hook", event: "session_start" }],
		context: "session",
		quiet: false,
		createdAt: 0,
	};
}

const idleCtx = {
	cwd: "/tmp",
	hasUI: true,
	isIdle: () => true,
	hasPendingMessages: () => false,
} as unknown as ExtensionContext;

function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
	const sent: string[] = [];
	const pi = {
		sendUserMessage(message: string) {
			sent.push(message);
		},
	} as unknown as ExtensionAPI;
	return { pi, sent };
}

function addRoutine(rt: RoutineRuntimeState, routine: Routine): void {
	rt.store.routines[routine.id] = routine;
	rt.store.tickState[routine.id] = {
		tickCount: 0,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
	};
}

function lastSkipReason(rt: RoutineRuntimeState, routineId: string): string | undefined {
	const runs = rt.store.tickState[routineId]?.runs ?? [];
	return runs[runs.length - 1]?.skipReason;
}

beforeEach(async () => {
	await flushStoreWrites();
});

describe("write-through mirror", () => {
	it("enqueue mirrors the entry into store.pendingQueue with queuedAt", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		const before = Date.now();
		enqueueRoutineFire(
			rt.store.routines.r1!,
			{ index: 0, kind: "pulse" },
			rt,
			makeFakePi().pi,
			() => idleCtx,
			{
				autoDrain: false,
			},
		);
		assert.equal(rt.store.pendingQueue.length, 1);
		const persisted = rt.store.pendingQueue[0]!;
		assert.equal(persisted.routineId, "r1");
		assert.equal(persisted.origin.kind, "pulse");
		assert.ok(
			typeof persisted.queuedAt === "number" && persisted.queuedAt >= before,
			"persisted entry carries an enqueue timestamp",
		);
		await flushStoreWrites();
	});

	it("deferred-hook entries are excluded from the mirror", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		enqueueRoutineFire(
			rt.store.routines.r1!,
			{ index: 0, kind: "hook" },
			rt,
			makeFakePi().pi,
			() => idleCtx,
			{
				autoDrain: false,
				deferredHookId: "dh-1",
				contextNote: "deferred",
			},
		);
		assert.equal(rt.queue.length, 1);
		assert.equal(rt.store.pendingQueue.length, 0);
		await flushStoreWrites();
	});

	it("overflow drop syncs the mirror", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		const { pi } = makeFakePi();
		for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
			enqueueRoutineFire(rt.store.routines.r1!, { index: 0, kind: "api" }, rt, pi, () => idleCtx, {
				autoDrain: false,
				runId: `run-${i}`,
			});
		}
		assert.equal(rt.store.pendingQueue.length, MAX_QUEUE_DEPTH);
		enqueueRoutineFire(rt.store.routines.r1!, { index: 0, kind: "api" }, rt, pi, () => idleCtx, {
			autoDrain: false,
			runId: "run-overflow",
		});
		assert.equal(rt.queue.length, MAX_QUEUE_DEPTH);
		assert.equal(rt.store.pendingQueue.length, MAX_QUEUE_DEPTH);
		assert.equal(rt.store.pendingQueue[0]?.runId, "run-1", "oldest entry dropped from mirror too");
		await flushStoreWrites();
	});

	it("drain shift removes the entry from the mirror before the turn starts", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		const { pi, sent } = makeFakePi();
		enqueueRoutineFire(rt.store.routines.r1!, { index: 0, kind: "pulse" }, rt, pi, () => idleCtx, {
			autoDrain: false,
		});
		assert.equal(rt.store.pendingQueue.length, 1);
		await drainQueue(rt, pi, () => idleCtx);
		assert.equal(sent.length, 1, "routine fired");
		assert.equal(rt.store.pendingQueue.length, 0);
		await flushStoreWrites();
		const onDisk = await loadStore();
		assert.equal(onDisk.pendingQueue.length, 0, "removal committed to disk");
	});

	it("persists through saveStore/loadStore against real fs", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		enqueueRoutineFire(
			rt.store.routines.r1!,
			{ index: 0, kind: "pulse" },
			rt,
			makeFakePi().pi,
			() => idleCtx,
			{
				autoDrain: false,
				runId: "roundtrip-1",
			},
		);
		await flushStoreWrites();
		const loaded = await loadStore();
		assert.equal(loaded.pendingQueue.length, 1);
		assert.equal(loaded.pendingQueue[0]?.runId, "roundtrip-1");
	});
});

describe("stopScheduler", () => {
	it("clears the in-memory queue without drop audits; mirror keeps the entries", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		enqueueRoutineFire(
			rt.store.routines.r1!,
			{ index: 0, kind: "pulse" },
			rt,
			makeFakePi().pi,
			() => idleCtx,
			{
				autoDrain: false,
			},
		);
		stopScheduler(rt, "session shutdown: quit");
		assert.equal(rt.queue.length, 0);
		assert.equal(rt.store.pendingQueue.length, 1, "entries survive in the store");
		assert.equal(
			(rt.store.tickState.r1?.runs ?? []).length,
			0,
			"no skip records — nothing was lost",
		);
		await flushStoreWrites();
	});
});

describe("rehydrateQueuedFires", () => {
	function seedPending(rt: RoutineRuntimeState, entries: RoutineQueueEntry[]): void {
		rt.store.pendingQueue.push(...entries);
	}

	it("re-enqueues survivors with runId, queuedAt, and payloads intact", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		const queuedAt = Date.now() - 60_000;
		seedPending(rt, [
			{
				routineId: "r1",
				runId: "survivor-1",
				origin: { index: 0, kind: "pulse" },
				queuedAt,
				apiArgs: { foo: "bar" },
			},
		]);
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 1);
		const entry = rt.queue[0]!;
		assert.equal(entry.runId, "survivor-1");
		assert.equal(entry.queuedAt, queuedAt);
		assert.deepEqual(entry.apiArgs, { foo: "bar" });
		// The persisted list is cleared up front, then enqueueRoutineFire's
		// write-through re-mirrors the rehydrated entry — the mirror must match
		// the in-memory queue again by the time rehydrate returns.
		assert.equal(rt.store.pendingQueue.length, 1, "mirror re-synced to the live queue");
		assert.equal(rt.store.pendingQueue[0]?.runId, "survivor-1");
		await flushStoreWrites();
	});

	it("expires entries older than MAX_QUEUED_FIRE_AGE_MS with an audited skip", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		seedPending(rt, [
			{
				routineId: "r1",
				runId: "stale-1",
				origin: { index: 0, kind: "pulse" },
				queuedAt: Date.now() - MAX_QUEUED_FIRE_AGE_MS - 1,
			},
		]);
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 0);
		assert.equal(lastSkipReason(rt, "r1"), "queued fire expired");
		await flushStoreWrites();
	});

	it("entries without queuedAt rehydrate as fresh rather than expiring", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		seedPending(rt, [{ routineId: "r1", runId: "legacy-1", origin: { index: 0, kind: "cron" } }]);
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 1);
		await flushStoreWrites();
	});

	it("skips paused routines with an audited skip", async () => {
		const rt = makeRuntime();
		addRoutine(rt, { ...makeRoutine("r1"), paused: true });
		seedPending(rt, [{ routineId: "r1", runId: "p1", origin: { index: 0, kind: "pulse" } }]);
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 0);
		assert.equal(lastSkipReason(rt, "r1"), "paused");
		await flushStoreWrites();
	});

	it("drops session_start hook fires as superseded by the fresh lifecycle pick", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeHookRoutine("h1"));
		seedPending(rt, [{ routineId: "h1", runId: "hook-1", origin: { index: 0, kind: "hook" } }]);
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 0);
		assert.equal(lastSkipReason(rt, "h1"), "superseded by fresh session_start hook");
		await flushStoreWrites();
	});

	it("dedups single-fire origins but lets api entries stack", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		seedPending(rt, [
			{ routineId: "r1", runId: "cron-1", origin: { index: 0, kind: "cron" } },
			{ routineId: "r1", runId: "cron-2", origin: { index: 0, kind: "cron" } },
			{ routineId: "r1", runId: "api-1", origin: { index: 0, kind: "api" } },
			{ routineId: "r1", runId: "api-2", origin: { index: 0, kind: "api" } },
		]);
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.deepEqual(
			rt.queue.map((entry) => entry.runId),
			["cron-1", "api-1", "api-2"],
		);
		assert.equal(lastSkipReason(rt, "r1"), "routine already queued");
		await flushStoreWrites();
	});

	it("drops entries for deleted routines without resurrecting tickState", async () => {
		const rt = makeRuntime();
		seedPending(rt, [{ routineId: "gone", runId: "ghost-1", origin: { index: 0, kind: "pulse" } }]);
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 0);
		assert.equal(rt.store.tickState.gone, undefined);
		await flushStoreWrites();
	});

	it("no-ops on an empty or absent persisted queue", async () => {
		const rt = makeRuntime();
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 0);
		rt.store.pendingQueue = undefined as unknown as RoutineQueueEntry[];
		rehydrateQueuedFires(rt, makeFakePi().pi, () => idleCtx);
		assert.equal(rt.queue.length, 0);
		await flushStoreWrites();
	});
});

describe("sanitizeStore pendingQueue", () => {
	it("drops malformed entries, unknown routines, and deferred-hook entries", async () => {
		const { sanitizeStore } = await import("../src/store.ts");
		const store = sanitizeStore({
			schemaVersion: 3,
			routines: { r1: makeRoutine("r1") },
			tickState: {},
			deferredHooks: [],
			pendingQueue: [
				{ routineId: "r1", runId: "ok-1", origin: { index: 0, kind: "pulse" } },
				{ routineId: "ghost", runId: "bad-1", origin: { index: 0, kind: "pulse" } },
				{
					routineId: "r1",
					runId: "bad-2",
					origin: { index: 0, kind: "pulse" },
					deferredHookId: "x",
				},
				{ routineId: "r1", runId: "bad-3", origin: { index: -5, kind: "pulse" } },
				{ routineId: "r1", runId: "bad-4", origin: { index: 0, kind: "nonsense" } },
				"not-an-object",
			],
		});
		assert.deepEqual(
			store.pendingQueue.map((entry) => entry.runId),
			["ok-1"],
		);
	});

	it("defaults a missing pendingQueue to empty (pre-existing v3 stores)", async () => {
		const { sanitizeStore } = await import("../src/store.ts");
		const store = sanitizeStore({
			schemaVersion: 3,
			routines: {},
			tickState: {},
			deferredHooks: [],
		});
		assert.deepEqual(store.pendingQueue, []);
	});

	it("caps an over-filled persisted queue at MAX_QUEUE_DEPTH, keeping the FIFO head", async () => {
		const { sanitizeStore } = await import("../src/store.ts");
		const store = sanitizeStore({
			schemaVersion: 3,
			routines: { r1: makeRoutine("r1") },
			tickState: {},
			deferredHooks: [],
			pendingQueue: Array.from({ length: MAX_QUEUE_DEPTH + 2 }, (_, i) => ({
				routineId: "r1",
				runId: `run-${i}`,
				origin: { index: 0, kind: "api" },
			})),
		});
		assert.equal(store.pendingQueue.length, MAX_QUEUE_DEPTH);
		assert.equal(store.pendingQueue[0]?.runId, "run-0");
	});
});

describe("store round-trip", () => {
	it("saveStore persists pendingQueue and loadStore recovers it", async () => {
		const store = emptyStore();
		store.routines.r1 = makeRoutine("r1");
		store.pendingQueue.push({
			routineId: "r1",
			runId: "fs-1",
			origin: { index: 0, kind: "cron" },
			queuedAt: 123,
		});
		await saveStore(store);
		await flushStoreWrites();
		const loaded = await loadStore();
		assert.equal(loaded.pendingQueue.length, 1);
		assert.equal(loaded.pendingQueue[0]?.queuedAt, 123);
	});

	it("persistQueue mirrors only non-deferred entries", async () => {
		const rt = makeRuntime();
		addRoutine(rt, makeRoutine("r1"));
		rt.queue.push(
			{ routineId: "r1", runId: "a", origin: { index: 0, kind: "pulse" } },
			{ routineId: "r1", runId: "b", origin: { index: 0, kind: "hook" }, deferredHookId: "dh" },
		);
		await persistQueue(rt);
		assert.deepEqual(
			rt.store.pendingQueue.map((entry) => entry.runId),
			["a"],
		);
		await flushStoreWrites();
	});
});
