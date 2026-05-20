/**
 * @file github-poller.ts — TP-011 GitHub event trigger.
 *
 * Owns the `case "github"` arm of `scheduler.armTrigger`. Each armed trigger
 * runs `gh api` periodically and, on previously-unseen events, calls the
 * shared {@link enqueueTriggerFire} so the routine joins the normal fire
 * queue (with dedup, collapse, backpressure, etc.).
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
 *   - On new event(s), the latest event id is written back to the trigger's
 *     `cursor` and persisted via `saveStore`. The injected `{ githubEvent }`
 *     template var (newest event JSON) is left in `runtime.userState` under
 *     `__githubEvent` so the executor / template-substitution layer can
 *     surface it later. v1 makes no further use of the payload.
 *
 * The actual `gh` invocation is funneled through {@link runGh} so tests can
 * swap it for a stub (`__setGhRunnerForTests`).
 */

import { spawn } from "node:child_process";
import { saveStore } from "./store.ts";
import { enqueueTriggerFire } from "./scheduler.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
		proc.stdout?.on("data", (b: Buffer) => {
			out += b.toString("utf8");
		});
		proc.stderr?.on("data", (b: Buffer) => {
			errBuf += b.toString("utf8");
		});
		proc.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code ?? "ESPAWN";
			resolve({ ok: false, error: code });
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				resolve({ ok: false, error: errBuf.trim() || `gh exit ${code}` });
				return;
			}
			try {
				resolve({ ok: true, json: JSON.parse(out) });
			} catch (e) {
				resolve({ ok: false, error: `parse: ${(e as Error).message}` });
			}
		});
	});
}

// ─── Endpoint mapping ────────────────────────────────────────────────────────

/** Build the `gh api` endpoint path for a given trigger. */
export function endpointFor(trigger: GithubTrigger): string {
	switch (trigger.event) {
		case "pull_request.opened":
			return `repos/${trigger.repo}/pulls?state=open&sort=created&direction=desc&per_page=30`;
		case "pull_request.closed":
			return `repos/${trigger.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`;
		case "issues.opened":
			return `repos/${trigger.repo}/issues?state=open&sort=created&direction=desc&per_page=30`;
		case "push":
			return `repos/${trigger.repo}/commits?per_page=30`;
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
export function normaliseEvents(trigger: GithubTrigger, json: unknown): NormalisedEvent[] {
	const items = asArray(json);
	const out: NormalisedEvent[] = [];
	for (const it of items) {
		let id: string | undefined;
		if (trigger.event === "push") {
			const sha = it.sha;
			if (typeof sha === "string") id = sha;
		} else {
			const num = it.number;
			if (typeof num === "number") id = String(num);
		}
		if (id) out.push({ id, payload: it });
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
			// `gh api repos/{r}/commits` does not include the ref; callers
			// should pass per-branch endpoints. We accept all commits when
			// branches filter is set and no ref info is available.
			// (Documented limitation; a follow-up could fan out per branch.)
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
	if (typeof trig.repo !== "string" || !trig.repo.includes("/")) {
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
 */
async function tickGithub(
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

	const result = await ghRunner(["api", endpointFor(trig)]);

	if (!result.ok) {
		if (result.error === "ENOENT") {
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
			`[pi-routines] github poll failed for '${routine.name}' (${trig.repo}): ${result.error}. Next try in ${Math.round(nextBackoff / 1000)}s.`,
		);
		return nextBackoff;
	}

	// Success — reset backoff.
	tstate.backoffMs = interval;
	tmap.set(key, tstate);

	const events = filterEvents(trig, normaliseEvents(trig, result.json));
	if (events.length === 0) return interval;

	// Events come back newest-first. The "newest" id becomes the next cursor.
	const newestId = events[0]?.id;
	const prevCursor = trig.cursor;

	if (prevCursor === undefined) {
		// First-time seed: persist newest id without firing.
		trig.cursor = newestId;
		await saveStore(runtime.store);
		return interval;
	}

	// Collect events strictly newer than the cursor. For numeric ids
	// (PR/issue numbers) we compare numerically; for shas we just take
	// everything up to (but not including) the cursor sha in order.
	const fresh: NormalisedEvent[] = [];
	for (const ev of events) {
		if (ev.id === prevCursor) break;
		fresh.push(ev);
	}
	if (fresh.length === 0) {
		// Cursor not present (e.g. items rolled past the page) — advance anyway.
		if (newestId && newestId !== prevCursor) {
			trig.cursor = newestId;
			await saveStore(runtime.store);
		}
		return interval;
	}

	// Stash newest fresh event for any downstream template-substitution.
	const tickState = runtime.store.tickState[routine.id];
	if (tickState) {
		tickState.userState = {
			...tickState.userState,
			__githubEvent: fresh[0]?.payload ?? null,
		};
	}

	trig.cursor = newestId;
	await saveStore(runtime.store);

	try {
		enqueueTriggerFire(live, triggerIndex, runtime, pi, getCtx);
	} catch (err) {
		console.error(`[pi-routines] github enqueue failed for '${routine.name}':`, err);
	}
	return interval;
}
