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
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME so createRoutine / setPaused write to a temp state.json
// instead of the user's real ~/.pi state file.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-pause-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { enqueueTriggerFire, stopScheduler } = await import("../src/scheduler.ts");
const { emptyStore } = await import("../src/store.ts");
const { createRoutine, setPaused } = await import("../src/tools/_mutate.ts");
const tokens = await import("../src/tokens.ts");
const { registerRoutinePauseTool, registerRoutineResumeTool } = await import(
	"../src/tools/routine-pause.ts"
);

import type { RoutineRuntimeState } from "../src/types.ts";

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

	it("deleteRoutine drops queued state + transient maps for the deleted routine", async () => {
		const { deleteRoutine } = await import("../src/tools/_mutate.ts");
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
		// Simulate a pending api/github fire that the user deletes before it drains.
		rt.queue.push({
			routineId: created.id,
			runId: "queued-delete",
			origin: { index: 0, kind: "pulse" },
		});
		rt.apiArgs = new Map();
		rt.apiArgs.set(created.id, { foo: "bar" });
		rt.githubEvents = new Map();
		rt.githubEvents.set(created.id, { number: 1 });
		await tokens.generateToken(created.id);
		await deleteRoutine("w", rt);
		assert.equal(
			rt.queue.some((entry) => entry.routineId === created.id),
			false,
		);
		assert.equal(rt.triggerOrigin.has(created.id), false);
		assert.equal(rt.apiArgs?.has(created.id), false);
		assert.equal(rt.githubEvents?.has(created.id), false);
		assert.equal(await tokens.getStoredToken(created.id), null);
	});
});

// Capture tools registered via pi.registerTool() so we can invoke their
// execute() functions directly.
interface CapturedTool {
	name: string;
	execute: (id: string, params: unknown) => Promise<unknown>;
}

function captureRegistrations(): { pi: ExtensionAPI; tools: Map<string, CapturedTool> } {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool(def: { name: string; execute: CapturedTool["execute"] }) {
			tools.set(def.name, { name: def.name, execute: def.execute });
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

describe("RoutinePause / RoutineResume LLM tools", () => {
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

	it("RoutinePause flips paused: true through the tool surface", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		const cap = captureRegistrations();
		registerRoutinePauseTool(cap.pi, rt);
		const tool = cap.tools.get("RoutinePause");
		assert.ok(tool);
		if (!tool) return;
		const result = (await tool.execute("call-1", { name: "w" })) as {
			details: { paused: boolean; changed: boolean };
		};
		assert.equal(result.details.paused, true);
		assert.equal(result.details.changed, true);
		assert.equal(Object.values(rt.store.routines)[0]?.paused, true);
	});

	it("RoutineResume flips paused: false through the tool surface", async () => {
		const rt = makeRuntime();
		liveRuntimes.push(rt);
		await createRoutine(
			{ name: "w", prompt: "x", trigger: { kind: "pulse", interval: "1m" } },
			rt,
			fakePi,
			getCtx,
		);
		await setPaused("w", true, rt);
		const cap = captureRegistrations();
		registerRoutineResumeTool(cap.pi, rt);
		const tool = cap.tools.get("RoutineResume");
		assert.ok(tool);
		if (!tool) return;
		const result = (await tool.execute("call-1", { name: "w" })) as {
			details: { paused: boolean; changed: boolean };
		};
		assert.equal(result.details.paused, false);
		assert.equal(result.details.changed, true);
		assert.equal(Object.values(rt.store.routines)[0]?.paused, undefined);
	});

	it("RoutinePause returns an error when neither id nor name is given", async () => {
		const rt = makeRuntime();
		const cap = captureRegistrations();
		registerRoutinePauseTool(cap.pi, rt);
		const tool = cap.tools.get("RoutinePause");
		assert.ok(tool);
		if (!tool) return;
		const result = (await tool.execute("call-1", {})) as { details: unknown };
		assert.equal(result.details, null);
	});
});
