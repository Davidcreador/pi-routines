/**
 * @file github-paused.test.ts — regression: paused routines don't invoke `gh`.
 *
 * Audit pass 1 found that `tickGithub` made the `gh api` call regardless of
 * `routine.paused`. This burned the authenticated user's rate-limit budget
 * for routines that couldn't fire anyway. Fix: short-circuit at the top of
 * the tick when paused, re-arming at the normal interval so resume is
 * instantaneous.
 *
 * The test swaps the gh runner via `__setGhRunnerForTests`, arms a poller,
 * ticks the clock, and asserts no gh call was attempted while paused — and
 * that a call DOES happen after resume.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Redirect HOME before importing modules that capture STATE_FILE.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-gh-paused-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { __setGhRunnerForTests, tickGithub } = await import("../src/github-poller.ts");
const { emptyStore } = await import("../src/store.ts");

import type { GhRunner } from "../src/github-poller.ts";
import type { GithubTrigger, Routine, RoutineRuntimeState } from "../src/types.ts";

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

let ghCalls: string[][] = [];
let prevRunner: GhRunner | null = null;

function makeGithubRoutine(paused: boolean): { routine: Routine; trigger: GithubTrigger } {
	const trigger: GithubTrigger = {
		kind: "github",
		repo: "owner/name",
		event: "pull_request.opened",
		pollIntervalMs: 60_000,
	};
	const routine: Routine = {
		id: "r1",
		name: "watch",
		prompt: "x",
		triggers: [trigger],
		context: "session",
		quiet: false,
		createdAt: 0,
		...(paused ? { paused: true } : {}),
	};
	return { routine, trigger };
}

beforeEach(() => {
	ghCalls = [];
	prevRunner = __setGhRunnerForTests(async (args) => {
		ghCalls.push(args);
		return { ok: true, json: [] };
	});
});

afterEach(() => {
	if (prevRunner) __setGhRunnerForTests(prevRunner);
});

describe("github poller — pause gate", () => {
	it("tickGithub skips the gh api call when the routine is paused", async () => {
		const rt = makeRuntime();
		const { routine } = makeGithubRoutine(true);
		rt.store.routines[routine.id] = routine;

		const nextDelay = await tickGithub(routine, 0, rt, fakePi, getCtx);

		assert.equal(ghCalls.length, 0, "no gh call should be made while paused");
		assert.equal(nextDelay, 60_000, "must re-arm at the normal interval for fast resume");
	});

	it("tickGithub invokes gh once the routine is no longer paused", async () => {
		const rt = makeRuntime();
		const { routine } = makeGithubRoutine(true);
		rt.store.routines[routine.id] = routine;

		await tickGithub(routine, 0, rt, fakePi, getCtx);
		assert.equal(ghCalls.length, 0);

		// Resume.
		delete routine.paused;
		await tickGithub(routine, 0, rt, fakePi, getCtx);

		assert.equal(ghCalls.length, 1, "after resume, the next poll calls gh");
		assert.deepEqual(ghCalls[0], [
			"api",
			"repos/owner/name/pulls?state=open&sort=created&direction=desc&per_page=30",
		]);
	});
});
