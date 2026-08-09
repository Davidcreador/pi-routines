/**
 * @file github-poller.test.ts — TP-011 unit tests for the GitHub poller.
 *
 * Covers:
 *   - endpoint mapping per event kind
 *   - event normalisation for PR/issue (numeric id) and push (sha)
 *   - filter logic: labels, mergedOnly
 *   - cursor seeding on first tick (no fire)
 *   - cursor advance + enqueue on subsequent ticks with new events
 *   - missing `gh` (ENOENT) does not crash; logs once; future ticks stay parked
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-gh-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const {
	__runGhProcessForTests,
	__setGhRunnerForTests,
	armGithubPoller,
	endpointFor,
	filterEvents,
	normaliseEvents,
	tickGithub,
} = await import("../src/github-poller.ts");
const { emptyStore, flushStoreWrites } = await import("../src/store.ts");

import type { GhResult } from "../src/github-poller.ts";
import type { GithubTrigger, Routine, RoutineRuntimeState } from "../src/types.ts";

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

function makeRoutine(trigger: GithubTrigger): Routine {
	return {
		id: "rt-gh",
		name: "gh-watch",
		prompt: "go",
		triggers: [trigger],
		context: "session",
		quiet: false,
		createdAt: 0,
	};
}

describe("github-poller — pure helpers", () => {
	it("endpointFor() picks the right gh api path per event", () => {
		const base: Omit<GithubTrigger, "event"> = {
			kind: "github",
			repo: "o/r",
			pollIntervalMs: 60_000,
		};
		assert.match(
			endpointFor({ ...base, event: "pull_request.opened" }),
			/repos\/o\/r\/pulls\?state=open/,
		);
		assert.match(
			endpointFor({ ...base, event: "pull_request.closed" }),
			/repos\/o\/r\/pulls\?state=closed/,
		);
		assert.match(
			endpointFor({ ...base, event: "issues.opened" }),
			/repos\/o\/r\/issues\?state=open/,
		);
		assert.match(endpointFor({ ...base, event: "push" }), /repos\/o\/r\/commits/);
	});

	it("normaliseEvents() keys PRs by number and commits by sha", () => {
		const pr: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.opened",
			pollIntervalMs: 60_000,
		};
		assert.deepEqual(
			normaliseEvents(pr, [{ number: 7 }, { number: 6 }]).map((e) => e.id),
			["7", "6"],
		);
		const push: GithubTrigger = { ...pr, event: "push" };
		assert.deepEqual(
			normaliseEvents(push, [{ sha: "abc" }, { sha: "def" }]).map((e) => e.id),
			["abc", "def"],
		);
	});

	it("excludes pull requests returned by the GitHub issues endpoint", () => {
		const trigger: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "issues.opened",
			pollIntervalMs: 60_000,
		};
		assert.deepEqual(
			normaliseEvents(trigger, [
				{ number: 9, title: "issue" },
				{ number: 10, pull_request: { url: "https://api.github.test/pr/10" } },
			]).map((event) => event.id),
			["9"],
		);
	});

	it("builds branch-specific push endpoints safely", () => {
		const trigger: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "push",
			pollIntervalMs: 60_000,
		};
		assert.match(endpointFor(trigger, "feature/a"), /sha=feature%2Fa/);
	});

	it("filterEvents() drops unmerged closed PRs when mergedOnly", () => {
		const t: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.closed",
			pollIntervalMs: 60_000,
			filter: { mergedOnly: true },
		};
		const evs = normaliseEvents(t, [
			{ number: 1, merged_at: "2026-01-01T00:00:00Z" },
			{ number: 2, merged_at: null },
		]);
		const passed = filterEvents(t, evs);
		assert.deepEqual(
			passed.map((e) => e.id),
			["1"],
		);
	});

	it("filterEvents() requires all listed labels on PRs", () => {
		const t: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.opened",
			pollIntervalMs: 60_000,
			filter: { labels: ["bug", "p1"] },
		};
		const evs = normaliseEvents(t, [
			{ number: 1, labels: [{ name: "bug" }, { name: "p1" }] },
			{ number: 2, labels: [{ name: "bug" }] },
		]);
		assert.deepEqual(
			filterEvents(t, evs).map((e) => e.id),
			["1"],
		);
	});
});

describe("github-poller — subprocess limits", () => {
	it("terminates gh when output exceeds the configured cap", async () => {
		if (process.platform === "win32") return;
		const bin = path.join(tmpHome, "bin-output");
		await fs.mkdir(bin, { recursive: true });
		const gh = path.join(bin, "gh");
		await fs.writeFile(gh, `#!/bin/sh\nprintf '${"x".repeat(128)}'\n`, "utf8");
		await fs.chmod(gh, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = bin;
		try {
			const result = await __runGhProcessForTests(["api", "ignored"], 1000, 32);
			assert.equal(result.ok, false);
			assert.match(result.error ?? "", /output exceeded/);
		} finally {
			process.env.PATH = previousPath;
		}
	});

	it("terminates gh when it exceeds the configured timeout", async () => {
		if (process.platform === "win32") return;
		const bin = path.join(tmpHome, "bin-timeout");
		await fs.mkdir(bin, { recursive: true });
		const gh = path.join(bin, "gh");
		await fs.writeFile(gh, "#!/bin/sh\n/bin/sleep 1\nprintf '[]'\n", "utf8");
		await fs.chmod(gh, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = bin;
		try {
			const result = await __runGhProcessForTests(["api", "ignored"], 20, 1024);
			assert.equal(result.ok, false);
			assert.match(result.error ?? "", /timed out/);
		} finally {
			process.env.PATH = previousPath;
		}
	});
});

describe("github-poller — armed lifecycle", () => {
	let restoreRunner: ReturnType<typeof __setGhRunnerForTests> | null = null;
	afterEach(() => {
		if (restoreRunner) {
			__setGhRunnerForTests(restoreRunner);
			restoreRunner = null;
		}
	});

	it("first tick seeds cursor without firing; second tick with new event enqueues", async () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.opened",
			pollIntervalMs: 60_000,
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		rt.store.tickState[routine.id] = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};

		// First tick: returns [#7] → cursor should become "7", no enqueue.
		// Second tick: returns [#8, #7] → cursor advances to "8", one enqueue.
		let call = 0;
		const stub = async (_args: string[]): Promise<GhResult> => {
			call += 1;
			if (call === 1) return { ok: true, json: [{ number: 7 }] };
			return { ok: true, json: [{ number: 8 }, { number: 7 }] };
		};
		restoreRunner = __setGhRunnerForTests(stub);

		await tickGithub(routine, 0, rt, {} as never, () => null);
		assert.equal(trig.cursor, "7");
		assert.equal(rt.queue.length, 0);

		await tickGithub(routine, 0, rt, {} as never, () => null);
		assert.equal(trig.cursor, "8");
		assert.equal(rt.queue.length, 1);
		const entry = rt.queue[0];
		assert.equal(typeof entry === "object" ? entry.githubEvent?.number : undefined, 8);
	});

	it("queues one fire per fresh GitHub event in chronological order", async () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.opened",
			pollIntervalMs: 60_000,
			cursor: "4",
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		restoreRunner = __setGhRunnerForTests(async () => ({
			ok: true,
			json: [{ number: 7 }, { number: 6 }, { number: 4 }],
		}));

		await tickGithub(routine, 0, rt, {} as never, () => null);

		assert.equal(trig.cursor, "7");
		assert.equal(rt.queue.length, 2);
		assert.deepEqual(
			rt.queue.map((entry) => (typeof entry === "object" ? entry.githubEvent?.number : undefined)),
			[6, 7],
		);
	});

	it("advances a missing cursor without replaying the bounded result page", async () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.opened",
			pollIntervalMs: 60_000,
			cursor: "missing",
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		restoreRunner = __setGhRunnerForTests(async () => ({
			ok: true,
			json: [{ number: 7 }, { number: 6 }],
		}));

		await tickGithub(routine, 0, rt, {} as never, () => null);

		assert.equal(trig.cursor, "7");
		assert.equal(rt.queue.length, 0);
	});

	it("locates the cursor before filtering so older matches are not replayed", async () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.opened",
			pollIntervalMs: 60_000,
			cursor: "6",
			filter: { labels: ["bug"] },
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		restoreRunner = __setGhRunnerForTests(async () => ({
			ok: true,
			json: [
				{ number: 7, labels: [] },
				{ number: 6, labels: [] },
				{ number: 5, labels: [{ name: "bug" }] },
			],
		}));

		await tickGithub(routine, 0, rt, {} as never, () => null);

		assert.equal(trig.cursor, "7");
		assert.equal(rt.queue.length, 0);
	});

	it("polls push branches independently and carries branch payloads", async () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "push",
			pollIntervalMs: 60_000,
			filter: { branches: ["main", "dev"] },
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		const calls = new Map<string, number>();
		restoreRunner = __setGhRunnerForTests(async (args) => {
			const endpoint = args[1] ?? "";
			const branch = endpoint.includes("sha=main") ? "main" : "dev";
			const call = (calls.get(branch) ?? 0) + 1;
			calls.set(branch, call);
			const oldSha = `${branch}-1`;
			const json =
				call === 1
					? [{ sha: oldSha }]
					: [
							{
								sha: `${branch}-2`,
								commit: { author: { date: branch === "main" ? "2026-01-02" : "2026-01-03" } },
							},
							{ sha: oldSha },
						];
			return { ok: true, json };
		});

		await tickGithub(routine, 0, rt, {} as never, () => null);
		assert.equal(rt.queue.length, 0);
		await tickGithub(routine, 0, rt, {} as never, () => null);

		assert.deepEqual(trig.branchCursors, { main: "main-2", dev: "dev-2" });
		assert.deepEqual(
			rt.queue.map((entry) => entry.githubEvent?.__branch),
			["main", "dev"],
		);
	});

	it("processes successful branches when another branch poll fails", async () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "push",
			pollIntervalMs: 60_000,
			filter: { branches: ["main", "release"] },
			branchCursors: { main: "main-1", release: "release-1" },
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		restoreRunner = __setGhRunnerForTests(async (args) => {
			const endpoint = args[1] ?? "";
			if (endpoint.includes("sha=release")) return { ok: false, error: "403" };
			return {
				ok: true,
				json: [{ sha: "main-2", commit: { author: { date: "2026-01-02" } } }, { sha: "main-1" }],
			};
		});

		const nextDelay = await tickGithub(routine, 0, rt, {} as never, () => null);

		assert.ok(nextDelay > trig.pollIntervalMs);
		assert.deepEqual(trig.branchCursors, { main: "main-2", release: "release-1" });
		assert.equal(rt.queue.length, 1);
		assert.equal(rt.queue[0]?.githubEvent?.__branch, "main");
	});

	it("missing gh (ENOENT) returns gracefully — no throw, handle returned", async () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "o/r",
			event: "pull_request.opened",
			pollIntervalMs: 60_000,
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		rt.store.tickState[routine.id] = {
			tickCount: 0,
			lastFiredAt: 0,
			lastFiredDateLocal: "",
			userState: {},
		};
		restoreRunner = __setGhRunnerForTests(async () => ({ ok: false, error: "ENOENT" }));
		const handle = armGithubPoller(
			routine,
			0,
			rt,
			// biome-ignore lint/suspicious/noExplicitAny: test scaffold
			{} as any,
			() => null,
		);
		assert.ok(handle);
		clearTimeout(handle as unknown as NodeJS.Timeout);
		// Did not throw, no enqueue occurred.
		assert.equal(rt.queue.length, 0);
	});

	it("rejects malformed repo with null handle", () => {
		const rt = makeRuntime();
		const trig: GithubTrigger = {
			kind: "github",
			repo: "not-a-repo",
			event: "issues.opened",
			pollIntervalMs: 60_000,
		};
		const routine = makeRoutine(trig);
		rt.store.routines[routine.id] = routine;
		const handle = armGithubPoller(
			routine,
			0,
			rt,
			// biome-ignore lint/suspicious/noExplicitAny: test scaffold
			{} as any,
			() => null,
		);
		assert.equal(handle, null);
	});
});
