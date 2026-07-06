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
const { stopScheduler } = await import("../src/scheduler.ts");
const { emptyStore, saveStore } = await import("../src/store.ts");
const { stopWidgetRefresh } = await import("../src/widget.ts");

import type { Routine, RoutineRuntimeState, RoutineStore } from "../src/types.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

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

function fakeCtx(statuses: string[] = []): ExtensionContext {
	return {
		hasUI: true,
		cwd: "/tmp/project",
		isIdle: () => true,
		hasPendingMessages: () => false,
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
		assert.deepEqual(rt.queue, [second.id]);

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
});
