/**
 * @file hooks-lifecycle.test.ts — integration-ish coverage for pi lifecycle hooks.
 *
 * These tests exercise registerHooks with a captured ExtensionAPI so lifecycle
 * bugs show up at the extension boundary: per-session hook state, multi-hook
 * startup queuing, and widget refresh startup after persisted routines load.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-hooks-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { registerHooks } = await import("../src/hooks.ts");
const { enqueueRoutineFire, stopScheduler } = await import("../src/scheduler.ts");
const { emptyStore, flushStoreWrites, saveStore } = await import("../src/store.ts");
const { stopWidgetRefresh } = await import("../src/widget.ts");

import type { Routine, RoutineRuntimeState, RoutineStore } from "../src/types.ts";

type Handler = (
	event: Record<string, unknown>,
	ctx: ExtensionContext,
) => unknown | Promise<unknown>;

const liveRuntimes: RoutineRuntimeState[] = [];

after(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	await fs.rm(tmpHome, { recursive: true, force: true });
});

afterEach(async () => {
	for (const rt of liveRuntimes.splice(0)) {
		stopScheduler(rt);
		stopWidgetRefresh(rt);
	}
	mock.timers.reset();
	await flushStoreWrites();
	await fs.rm(path.join(tmpHome, ".pi"), { recursive: true, force: true });
});

function makeRuntime(): RoutineRuntimeState {
	const rt: RoutineRuntimeState = {
		store: emptyStore(),
		timers: new Map(),
		queue: [],
		isRoutineTurnActive: false,
		activeRoutineName: null,
		lastUiCtx: null,
		sessionHookFires: new Set(),
		triggerOrigin: new Map(),
		pendingRun: null,
	};
	liveRuntimes.push(rt);
	return rt;
}

function capturePi(): {
	pi: ExtensionAPI;
	handlers: Map<string, Handler>;
	sentMessages: string[];
} {
	const handlers = new Map<string, Handler>();
	const sentMessages: string[] = [];
	const pi = {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, handler);
		},
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, sentMessages };
}

function fakeCtx(
	statuses: string[] = [],
	options: {
		sessionId?: string;
		messages?: Array<{ role: string; text: string }>;
		isIdle?: () => boolean;
		hasUI?: boolean;
	} = {},
): ExtensionContext {
	return {
		hasUI: options.hasUI ?? true,
		cwd: "/tmp/project",
		isIdle: options.isIdle ?? (() => true),
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-1",
			getBranch: () =>
				(options.messages ?? []).map((message, index) => ({
					type: "message",
					id: `message-${index}`,
					parentId: index > 0 ? `message-${index - 1}` : null,
					timestamp: new Date(0).toISOString(),
					message: {
						role: message.role,
						content: [{ type: "text", text: message.text }],
					},
				})),
		},
		ui: {
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value ?? "");
			},
		},
	} as unknown as ExtensionContext;
}

function hookRoutine(
	id: string,
	event: "session_start" | "agent_end" | "session_shutdown",
	once?: "daily" | "per_session",
): Routine {
	return {
		id,
		name: `routine-${id}`,
		prompt: `prompt ${id}`,
		triggers: [{ kind: "hook", event, ...(once ? { once } : {}) }],
		context: "session",
		quiet: false,
		createdAt: 0,
	};
}

function pulseRoutine(id: string): Routine {
	return {
		id,
		name: `routine-${id}`,
		prompt: `prompt ${id}`,
		triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
		context: "session",
		quiet: false,
		createdAt: Date.parse("2026-06-01T00:00:00Z"),
	};
}

async function seedStore(mutator: (store: RoutineStore) => void): Promise<void> {
	const store = emptyStore();
	mutator(store);
	await saveStore(store);
}

describe("hooks lifecycle", () => {
	it("fires once:per_session hooks in a new session even after persisted prior ticks", async () => {
		const routine = hookRoutine("wrap", "session_start", "per_session");
		await seedStore((store) => {
			store.routines[routine.id] = routine;
			store.tickState[routine.id] = {
				tickCount: 7,
				lastFiredAt: Date.parse("2026-06-01T00:00:00Z"),
				lastFiredDateLocal: "2026-06-01",
				userState: {},
			};
		});
		const rt = makeRuntime();
		const cap = capturePi();
		let currentCtx = fakeCtx();
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_start")?.({ reason: "launch" }, currentCtx);
		assert.equal(cap.sentMessages.length, 1);
		assert.match(cap.sentMessages[0] ?? "", /tick 8/);

		await cap.handlers.get("agent_end")?.({}, currentCtx);
		await cap.handlers.get("session_start")?.({ reason: "reload" }, currentCtx);
		assert.equal(cap.sentMessages.length, 1, "reload should not reset per-session hooks");

		await cap.handlers.get("session_start")?.({ reason: "launch" }, currentCtx);
		assert.equal(cap.sentMessages.length, 2, "a fresh session should reset per-session hooks");
	});

	it("queues multiple session_start hooks and drains them over routine turns", async () => {
		const first = hookRoutine("first", "session_start");
		const second = hookRoutine("second", "session_start");
		await seedStore((store) => {
			store.routines[first.id] = first;
			store.routines[second.id] = second;
		});
		const rt = makeRuntime();
		const cap = capturePi();
		let currentCtx = fakeCtx();
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_start")?.({ reason: "launch" }, currentCtx);
		assert.equal(cap.sentMessages.length, 1);
		assert.match(cap.sentMessages[0] ?? "", /routine-first/);
		assert.deepEqual(
			rt.queue.map((entry) => entry.routineId),
			[second.id],
		);

		await cap.handlers.get("agent_end")?.({}, currentCtx);
		assert.equal(cap.sentMessages.length, 2);
		assert.match(cap.sentMessages[1] ?? "", /routine-second/);
	});

	it("starts widget refresh after session_start loads persisted timed routines", async () => {
		mock.timers.enable({
			apis: ["setInterval", "setTimeout"],
			now: Date.parse("2026-06-01T00:00:00Z"),
		});
		const routine = pulseRoutine("pulse");
		await seedStore((store) => {
			store.routines[routine.id] = routine;
		});
		const rt = makeRuntime();
		const cap = capturePi();
		const statuses: string[] = [];
		let currentCtx = fakeCtx(statuses);
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_start")?.({ reason: "launch" }, currentCtx);
		const statusCountAfterStart = statuses.length;
		assert.ok(statusCountAfterStart > 0);

		mock.timers.tick(10_000);
		assert.ok(statuses.length > statusCountAfterStart);
	});

	it("defers shutdown hooks and replays them with transcript context next session", async () => {
		const routine = hookRoutine("wrap", "session_shutdown", "per_session");
		await seedStore((store) => {
			store.routines[routine.id] = routine;
		});

		const firstRuntime = makeRuntime();
		const first = capturePi();
		let firstCtx = fakeCtx([], {
			sessionId: "ended-session",
			messages: [
				{ role: "user", text: "Fix the deployment" },
				{ role: "assistant", text: "Deployment fixed" },
			],
		});
		registerHooks(
			first.pi,
			firstRuntime,
			() => firstCtx,
			(ctx) => {
				firstCtx = ctx;
			},
		);
		await first.handlers.get("session_start")?.({ reason: "startup" }, firstCtx);
		await first.handlers.get("session_shutdown")?.({ reason: "quit" }, firstCtx);

		assert.equal(first.sentMessages.length, 0, "teardown must not start an LLM turn");
		assert.equal(firstRuntime.store.deferredHooks.length, 1);

		const secondRuntime = makeRuntime();
		const second = capturePi();
		let secondCtx = fakeCtx([], { sessionId: "next-session" });
		registerHooks(
			second.pi,
			secondRuntime,
			() => secondCtx,
			(ctx) => {
				secondCtx = ctx;
			},
		);
		await second.handlers.get("session_start")?.({ reason: "startup" }, secondCtx);

		assert.equal(second.sentMessages.length, 1);
		assert.match(second.sentMessages[0] ?? "", /Fix the deployment/);
		assert.match(second.sentMessages[0] ?? "", /previous session ended/i);
		assert.equal(secondRuntime.store.deferredHooks.length, 0);
	});

	it("commits per-session markers only after a queued hook actually starts", async () => {
		const routine = hookRoutine("start", "session_start", "per_session");
		await seedStore((store) => {
			store.routines[routine.id] = routine;
		});
		const rt = makeRuntime();
		const cap = capturePi();
		let idle = false;
		let currentCtx = fakeCtx([], { isIdle: () => idle });
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_start")?.({ reason: "startup" }, currentCtx);
		assert.equal(cap.sentMessages.length, 0);
		assert.equal(rt.sessionHookFires?.size, 0);

		idle = true;
		await cap.handlers.get("agent_end")?.({}, currentCtx);
		assert.equal(cap.sentMessages.length, 1);
		assert.equal(rt.sessionHookFires?.size, 1);
	});

	it("tracks once:daily by hook trigger instead of sibling routine fires", async () => {
		const routine = hookRoutine("daily", "session_start", "daily");
		routine.triggers.unshift({ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" });
		await seedStore((store) => {
			store.routines[routine.id] = routine;
			store.tickState[routine.id] = {
				tickCount: 4,
				lastFiredAt: Date.now(),
				lastFiredDateLocal: new Date().toLocaleDateString("en-CA"),
				userState: {},
			};
		});
		const rt = makeRuntime();
		const cap = capturePi();
		let currentCtx = fakeCtx();
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_start")?.({ reason: "startup" }, currentCtx);
		assert.equal(cap.sentMessages.length, 1);
	});

	it("marks a daily hook satisfied when the daily cap skips it", async () => {
		const routine = hookRoutine("capped", "agent_end", "daily");
		routine.maxRunsPerDay = 1;
		await seedStore((store) => {
			store.routines[routine.id] = routine;
			store.tickState[routine.id] = {
				tickCount: 1,
				lastFiredAt: Date.now(),
				lastFiredDateLocal: new Date().toLocaleDateString("en-CA"),
				userState: {},
				runsToday: 1,
				runsTodayDate: new Date().toLocaleDateString("en-CA"),
			};
		});
		const rt = makeRuntime();
		const cap = capturePi();
		let currentCtx = fakeCtx();
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);
		await cap.handlers.get("session_start")?.({ reason: "startup" }, currentCtx);

		await cap.handlers.get("agent_end")?.({}, currentCtx);
		await cap.handlers.get("agent_end")?.({}, currentCtx);

		assert.equal(cap.sentMessages.length, 0);
		assert.equal(rt.store.tickState[routine.id]?.runs?.length, 1);
		assert.equal(rt.store.tickState[routine.id]?.runs?.[0]?.skipReason, "daily cap reached");
	});

	it("expires deferred shutdown hooks even in print mode", async () => {
		const routine = hookRoutine("expired", "session_shutdown", "per_session");
		await seedStore((store) => {
			store.routines[routine.id] = routine;
			store.deferredHooks.push({
				id: "old-deferred",
				routineId: routine.id,
				triggerIndex: 0,
				endedSessionId: "old-session",
				deferredAt: Date.now() - 8 * 24 * 60 * 60_000,
				endedSessionCwd: "/tmp/old",
				endedDateLocal: "2026-01-01",
				endedTimeLocal: "12:00:00",
				transcript: "old",
			});
		});
		const rt = makeRuntime();
		const cap = capturePi();
		let currentCtx = fakeCtx([], { hasUI: false });
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_start")?.({ reason: "startup" }, currentCtx);

		assert.equal(rt.store.deferredHooks.length, 0);
		assert.equal(
			rt.store.tickState[routine.id]?.runs?.at(-1)?.skipReason,
			"deferred shutdown hook expired",
		);
	});

	it("supersedes an older deferred wrap for the same routine", async () => {
		const routine = hookRoutine("wrap-latest", "session_shutdown", "per_session");
		const rt = makeRuntime();
		rt.store.routines[routine.id] = routine;
		rt.store.deferredHooks.push({
			id: "older",
			routineId: routine.id,
			triggerIndex: 0,
			endedSessionId: "older-session",
			deferredAt: 1,
			endedSessionCwd: "/tmp/older",
			endedDateLocal: "2026-01-01",
			endedTimeLocal: "12:00:00",
			transcript: "older transcript",
		});
		const cap = capturePi();
		let currentCtx = fakeCtx([], {
			sessionId: "newer-session",
			messages: [{ role: "user", text: "newer transcript" }],
		});
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_shutdown")?.({ reason: "quit" }, currentCtx);

		assert.equal(rt.store.deferredHooks.length, 1);
		assert.equal(rt.store.deferredHooks[0]?.endedSessionId, "newer-session");
		assert.equal(
			rt.store.tickState[routine.id]?.runs?.at(-1)?.skipReason,
			"superseded deferred shutdown hook",
		);
	});

	it("captures shutdown hooks while finalizing an interrupted routine turn", async () => {
		const wrap = hookRoutine("wrap-interrupted", "session_shutdown", "per_session");
		const active = pulseRoutine("active");
		const rt = makeRuntime();
		rt.store.routines[wrap.id] = wrap;
		rt.store.routines[active.id] = active;
		rt.isRoutineTurnActive = true;
		rt.activeRoutineName = active.name;
		rt.pendingRun = {
			routineId: active.id,
			runId: "interrupted-run",
			triggerIndex: 0,
			triggerKind: "pulse",
			startedAt: Date.now() - 100,
			snippet: "",
			status: "success",
		};
		const cap = capturePi();
		let currentCtx = fakeCtx([], { sessionId: "interrupted-session" });
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);

		await cap.handlers.get("session_shutdown")?.({ reason: "quit" }, currentCtx);

		assert.equal(rt.isRoutineTurnActive, false);
		assert.equal(rt.pendingRun, null);
		assert.equal(rt.store.deferredHooks.length, 1);
		assert.equal(rt.store.tickState[active.id]?.runs?.at(-1)?.status, "error");
	});

	it("drains a pulse queued mid-turn via agent_settled (regression: pulse fired only once)", async () => {
		// A pulse routine whose turn outlives its interval stalls if the queued
		// fire is never processed. At `agent_end`, Pi's internal run flag is
		// still set so `ctx.isIdle()` is false and drainQueue bails, leaving
		// the pulse stuck. `agent_settled` must be the authoritative drain.
		const routine = pulseRoutine("pulse-once");
		const rt = makeRuntime();
		// Stale generation turns fireRoutine's saveStore into a no-op so this
		// test never writes to the shared STATE_FILE (parallel test isolation).
		rt.storeGeneration = -1;
		rt.store.routines[routine.id] = routine;
		const cap = capturePi();
		let idle = false; // agent stays busy through agent_end
		let currentCtx = fakeCtx([], { isIdle: () => idle });
		registerHooks(
			cap.pi,
			rt,
			() => currentCtx,
			(ctx) => {
				currentCtx = ctx;
			},
		);
		const settledHandler = cap.handlers.get("agent_settled");
		assert.ok(settledHandler, "agent_settled handler must be registered");

		// Enqueue the first fire directly (no session_start needed) to model a
		// pulse that fired while the previous turn was still in flight.
		enqueueRoutineFire(routine, { index: 0, kind: "pulse" }, rt, cap.pi, () => currentCtx, {
			autoDrain: false,
		});

		// agent_end arrives while the agent is (still) busy -> drainQueue bails.
		await cap.handlers.get("agent_end")?.({}, currentCtx);
		assert.equal(cap.sentMessages.length, 0, "agent_end must not fire while not idle");
		assert.equal(
			rt.queue.filter((entry) => entry.routineId === routine.id).length,
			1,
			"queued pulse must survive the agent_end drain bail",
		);

		// Agent settles -> isIdle flips true -> agent_settled drains the queue.
		idle = true;
		await settledHandler({}, currentCtx);
		assert.equal(cap.sentMessages.length, 1, "agent_settled must process the stuck pulse");
		assert.equal(rt.queue.length, 0);
	});
});
