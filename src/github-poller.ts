/**
 * @file github-poller.ts — TP-011 GitHub event trigger.
 *
 * Owns the `case "github"` arm of `scheduler.armTrigger`. Each armed trigger
 * runs `gh api` periodically and, on previously-unseen events, calls the
 * shared {@link enqueueFireRequest} so each event keeps its own payload.
 *
 * Design rules:
 *   - Poll interval is bounded by {@link MIN_GITHUB_POLL_MS}; smaller values
 *     are silently clamped up by the caller (see `_mutate`).
 *   - First successful tick seeds `cursor` WITHOUT firing — we only fire on
 *     events newer than the seed.
 *   - Consecutive `gh` failures back off 2× the trigger's `pollIntervalMs`,
 *     capped at {@link MAX_GITHUB_BACKOFF_MS}. A successful tick resets.
 *   - Missing `gh` (ENOENT) → log once, leave the timer slot null, never
 *     crash. Other routines keep running.
 *   - Push branch filters poll branch-specific endpoints with independent
 *     cursors. Cursor loss advances without replaying the bounded result page.
 *   - Each fresh event is queued before its cursor is persisted, preferring
 *     at-least-once replay over permanent loss on process failure.
 *
 * The actual `gh` invocation is funneled through `defaultGhRunner` so tests can
 * swap it for a stub (`__setGhRunnerForTests`).
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { enqueueFireRequest } from "./scheduler.ts";
import { saveStore } from "./store.ts";
import type { GithubTrigger, Routine, RoutineRuntimeState } from "./types.ts";
import { MAX_GITHUB_BACKOFF_MS, MIN_GITHUB_POLL_MS } from "./types.ts";

// ─── Test seam ───────────────────────────────────────────────────────────────

/** Result of one `gh` invocation: parsed JSON body. */
export interface GhResult {
	ok: boolean;
	json?: unknown;
	/** Error code/marker; "ENOENT" means `gh` is not installed. */
	error?: string;
}

export type GhRunner = (args: string[]) => Promise<GhResult>;

let ghRunner: GhRunner = defaultGhRunner;
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Test-only: substitute the `gh` invoker. Returns the previous runner. */
export function __setGhRunnerForTests(runner: GhRunner): GhRunner {
	const prev = ghRunner;
	ghRunner = runner;
	return prev;
}

function defaultGhRunner(args: string[]): Promise<GhResult> {
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? "ESPAWN";
			resolve({ ok: false, error: code });
			return;
		}
		let out = "";
		let errBuf = "";
		let outputBytes = 0;
		let settled = false;
		const finish = (result: GhResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};
		const onChunk = (b: Buffer, target: "stdout" | "stderr") => {
			outputBytes += b.length;
			if (outputBytes > GH_MAX_OUTPUT_BYTES) {
				proc.kill("SIGTERM");
				finish({ ok: false, error: "gh output exceeded 2 MiB" });
				return;
			}
			if (target === "stdout") out += b.toString("utf8");
			else errBuf += b.toString("utf8");
		};
		const timeout = setTimeout(() => {
			proc.kill("SIGTERM");
			finish({ ok: false, error: `gh timed out after ${GH_TIMEOUT_MS / 1000}s` });
		}, GH_TIMEOUT_MS);
		proc.stdout?.on("data", (b: Buffer) => {
			onChunk(b, "stdout");
		});
		proc.stderr?.on("data", (b: Buffer) => {
			onChunk(b, "stderr");
		});
		proc.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code ?? "ESPAWN";
			finish({ ok: false, error: code });
		});
		proc.on("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				finish({ ok: false, error: errBuf.trim() || `gh exit ${code}` });
				return;
			}
			try {
				finish({ ok: true, json: JSON.parse(out) });
			} catch (e) {
				finish({ ok: false, error: `parse: ${(e as Error).message}` });
			}
		});
	});
}

// ─── Endpoint mapping ────────────────────────────────────────────────────────

/** Build the `gh api` endpoint path for a given trigger. */
export function endpointFor(trigger: GithubTrigger, branch?: string): string {
	switch (trigger.event) {
		case "pull_request.opened":
			return `repos/${trigger.repo}/pulls?state=open&sort=created&direction=desc&per_page=30`;
		case "pull_request.closed":
			return `repos/${trigger.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`;
		case "issues.opened":
			return `repos/${trigger.repo}/issues?state=open&sort=created&direction=desc&per_page=30`;
		case "push":
			return `repos/${trigger.repo}/commits?${branch ? `sha=${encodeURIComponent(branch)}&` : ""}per_page=30`;
	}
}

// ─── Event normalisation + filtering ─────────────────────────────────────────

/** Normalised event shape used internally. */
export interface NormalisedEvent {
	/** Monotonically-comparable id (PR number, issue number, or commit sha). */
	id: string;
	/** Raw payload from the GitHub API. */
	payload: Record<string, unknown>;
}

function asArray(json: unknown): Record<string, unknown>[] {
	return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
}

/**
 * Parse a `gh` JSON result into normalised events newest-first. PRs and
 * issues key on `number`; commits key on `sha`.
 */
export function normaliseEvents(
	trigger: GithubTrigger,
	json: unknown,
	branch?: string,
): NormalisedEvent[] {
	const items = asArray(json);
	const out: NormalisedEvent[] = [];
	for (const it of items) {
		if (trigger.event === "issues.opened" && "pull_request" in it) continue;
		let id: string | undefined;
		if (trigger.event === "push") {
			const sha = it.sha;
			if (typeof sha === "string") id = sha;
		} else {
			const num = it.number;
			if (typeof num === "number") id = String(num);
		}
		if (id) {
			out.push({
				id,
				payload: branch ? { ...it, __branch: branch } : it,
			});
		}
	}
	return out;
}

/** Apply the trigger's filter block. Returns events that pass. */
export function filterEvents(trigger: GithubTrigger, events: NormalisedEvent[]): NormalisedEvent[] {
	const f = trigger.filter;
	if (!f) return events;
	return events.filter((ev) => {
		if (trigger.event === "pull_request.closed" && f.mergedOnly) {
			if (!ev.payload.merged_at) return false;
		}
		if (
			(trigger.event === "pull_request.opened" || trigger.event === "pull_request.closed") &&
			f.labels &&
			f.labels.length > 0
		) {
			const labels = Array.isArray(ev.payload.labels)
				? (ev.payload.labels as Array<{ name?: string }>).map((l) => l?.name ?? "")
				: [];
			for (const want of f.labels) {
				if (!labels.includes(want)) return false;
			}
		}
		if (trigger.event === "push" && f.branches && f.branches.length > 0) {
			if (!f.branches.includes(String(ev.payload.__branch ?? ""))) return false;
		}
		return true;
	});
}

// ─── Tick + arm ──────────────────────────────────────────────────────────────

/** Per-trigger runtime bookkeeping (failure backoff). Keyed by routineId+idx. */
const tickerState = new WeakMap<
	RoutineRuntimeState,
	Map<string, { backoffMs: number; ghMissingLogged: boolean }>
>();

function getTickerMap(
	runtime: RoutineRuntimeState,
): Map<string, { backoffMs: number; ghMissingLogged: boolean }> {
	let m = tickerState.get(runtime);
	if (!m) {
		m = new Map();
		tickerState.set(runtime, m);
	}
	return m;
}

function keyOf(routineId: string, idx: number): string {
	return `${routineId}:${idx}`;
}

function eventsAfterCursor(
	events: NormalisedEvent[],
	cursor: string | undefined,
): { nextCursor?: string; fresh: NormalisedEvent[]; cursorMissing: boolean } {
	const nextCursor = events[0]?.id;
	if (!nextCursor) return { fresh: [], cursorMissing: false };
	if (cursor === undefined) return { nextCursor, fresh: [], cursorMissing: false };
	const cursorIndex = events.findIndex((event) => event.id === cursor);
	if (cursorIndex < 0) {
		// The page is bounded. Replaying every item would duplicate old work;
		// advance safely and wait for the next poll.
		return { nextCursor, fresh: [], cursorMissing: true };
	}
	return { nextCursor, fresh: events.slice(0, cursorIndex), cursorMissing: false };
}

function eventTime(event: NormalisedEvent): number {
	const direct = event.payload.created_at ?? event.payload.updated_at;
	if (typeof direct === "string") return Date.parse(direct) || 0;
	const commit = event.payload.commit;
	if (commit && typeof commit === "object") {
		const author = (commit as { author?: unknown }).author;
		if (author && typeof author === "object") {
			const date = (author as { date?: unknown }).date;
			if (typeof date === "string") return Date.parse(date) || 0;
		}
	}
	return 0;
}

/**
 * Arm a github poller for one trigger of `routine`. Returns the timer handle
 * stored in `runtime.timers`. Returns `null` when the trigger payload is
 * malformed (logged, but does not throw).
 */
export function armGithubPoller(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): ReturnType<typeof setTimeout> | null {
	const trig = routine.triggers[triggerIndex];
	if (!trig || trig.kind !== "github") return null;
	if (typeof trig.repo !== "string" || !/^[^/?#\s]+\/[^/?#\s]+$/.test(trig.repo)) {
		console.warn(`[pi-routines] github: invalid repo for '${routine.name}': ${String(trig.repo)}`);
		return null;
	}

	const interval = Math.max(MIN_GITHUB_POLL_MS, trig.pollIntervalMs);
	const key = keyOf(routine.id, triggerIndex);
	getTickerMap(runtime).set(key, { backoffMs: interval, ghMissingLogged: false });

	const schedule = (delay: number): ReturnType<typeof setTimeout> =>
		setTimeout(() => {
			void tickGithub(routine, triggerIndex, runtime, pi, getCtx).then(
				(nextDelay) => {
					// Re-arm only if routine + trigger still present.
					const live = runtime.store.routines[routine.id];
					if (!live) return;
					const stillSame = live.triggers[triggerIndex];
					if (!stillSame || stillSame.kind !== "github") return;
					const h = schedule(nextDelay);
					const arr = runtime.timers.get(routine.id);
					if (arr) arr[triggerIndex] = h as unknown as ReturnType<typeof setInterval>;
				},
				(err) => {
					console.error(`[pi-routines] github poller unexpected error for '${routine.name}':`, err);
				},
			);
		}, delay);

	return schedule(interval) as unknown as ReturnType<typeof setInterval>;
}

/**
 * One poll cycle. Returns the delay in ms for the next tick (interval on
 * success, escalated backoff on failure).
 *
 * Exported only so tests can exercise this directly (driving it through the
 * real `armGithubPoller` setTimeout chain requires `mock.timers.tickAsync`,
 * which isn't yet stable in Node 22 — calling this function lets tests
 * cover the paused-short-circuit and backoff paths without timing hacks).
 */
export async function tickGithub(
	routine: Routine,
	triggerIndex: number,
	runtime: RoutineRuntimeState,
	pi: ExtensionAPI,
	getCtx: () => ExtensionContext | null,
): Promise<number> {
	const live = runtime.store.routines[routine.id];
	const trig = live?.triggers[triggerIndex];
	if (!live || !trig || trig.kind !== "github") {
		return MAX_GITHUB_BACKOFF_MS; // routine gone — next re-arm guard will stop it
	}

	const interval = Math.max(MIN_GITHUB_POLL_MS, trig.pollIntervalMs);
	const key = keyOf(routine.id, triggerIndex);
	const tmap = getTickerMap(runtime);
	const tstate = tmap.get(key) ?? { backoffMs: interval, ghMissingLogged: false };

	// Paused routines skip the gh api call entirely — no point burning the
	// authenticated user's rate-limit budget on a routine that can't fire.
	// We still re-arm at the normal interval so resume is instantaneous.
	if (live.paused) {
		return interval;
	}

	const branches =
		trig.event === "push"
			? [...new Set((trig.filter?.branches ?? []).map((branch) => branch.trim()).filter(Boolean))]
			: [];
	const polls =
		branches.length > 0
			? await Promise.all(
					branches.map(async (branch) => ({
						branch,
						result: await ghRunner(["api", endpointFor(trig, branch)]),
					})),
				)
			: [{ branch: undefined, result: await ghRunner(["api", endpointFor(trig)]) }];
	const failure = polls.find(({ result }) => !result.ok)?.result;

	if (failure && !failure.ok) {
		if (failure.error === "ENOENT") {
			if (!tstate.ghMissingLogged) {
				console.warn(
					`[pi-routines] github: 'gh' CLI not found — disabling poller for '${routine.name}'. Install gh and reload.`,
				);
				tstate.ghMissingLogged = true;
				tmap.set(key, tstate);
			}
			// Park at max backoff; if user later installs gh, /reload re-arms.
			return MAX_GITHUB_BACKOFF_MS;
		}
		const nextBackoff = Math.min(tstate.backoffMs * 2, MAX_GITHUB_BACKOFF_MS);
		tstate.backoffMs = nextBackoff;
		tmap.set(key, tstate);
		console.warn(
			`[pi-routines] github poll failed for '${routine.name}' (${trig.repo}): ${failure.error}. Next try in ${Math.round(nextBackoff / 1000)}s.`,
		);
		return nextBackoff;
	}

	// Success — reset backoff.
	tstate.backoffMs = interval;
	tmap.set(key, tstate);

	const fresh: NormalisedEvent[] = [];
	let cursorChanged = false;
	let seeded = false;

	if (branches.length > 0) {
		const cursors = { ...(trig.branchCursors ?? {}) };
		for (const poll of polls) {
			const branch = poll.branch as string;
			const events = normaliseEvents(trig, poll.result.json, branch);
			const previous = cursors[branch];
			const batch = eventsAfterCursor(events, previous);
			if (batch.cursorMissing) {
				console.warn(
					`[pi-routines] github cursor for '${routine.name}' branch '${branch}' left the result page; advancing without replay`,
				);
			}
			if (batch.nextCursor && batch.nextCursor !== previous) {
				cursors[branch] = batch.nextCursor;
				cursorChanged = true;
			}
			if (previous === undefined && batch.nextCursor) seeded = true;
			fresh.push(...filterEvents(trig, batch.fresh));
		}
		trig.branchCursors = cursors;
	} else {
		const events = normaliseEvents(trig, polls[0]?.result.json);
		const previous = trig.cursor;
		const batch = eventsAfterCursor(events, previous);
		if (batch.cursorMissing) {
			console.warn(
				`[pi-routines] github cursor for '${routine.name}' left the result page; advancing without replay`,
			);
		}
		if (batch.nextCursor && batch.nextCursor !== previous) {
			trig.cursor = batch.nextCursor;
			cursorChanged = true;
		}
		if (previous === undefined && batch.nextCursor) seeded = true;
		fresh.push(...filterEvents(trig, batch.fresh));
	}

	// Queue before persisting the cursor. A crash can then cause an at-least-once
	// replay, but cannot permanently lose an event between cursor save and enqueue.
	fresh.sort((a, b) => eventTime(a) - eventTime(b));
	for (const ev of fresh) {
		try {
			enqueueFireRequest(live, triggerIndex, runtime, pi, getCtx, { githubEvent: ev.payload });
		} catch (err) {
			console.error(`[pi-routines] github enqueue failed for '${routine.name}':`, err);
		}
	}
	if (cursorChanged || seeded) {
		await saveStore(runtime.store, runtime.storeGeneration);
	}
	return interval;
}
