/**
 * @file types.ts — single source of truth for pi-routines shared types & constants.
 *
 * All other modules (store, parser, guard, scheduler, executor, hooks, tools,
 * commands, widget) import their shapes from this file. Downstream tasks read
 * the JSDoc here as the contract.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Tiers ───────────────────────────────────────────────────────────────────

/** Two top-level kinds of routine: time-based ("pulse") vs. event-based ("hook"). */
export type RoutineTier = "pulse" | "hook";

// ─── Triggers ────────────────────────────────────────────────────────────────

/** Pulse trigger: fires on a fixed interval. */
export interface PulseTrigger {
	kind: "pulse";
	/** Resolved interval in milliseconds. */
	intervalMs: number;
	/** Original human-readable string, e.g. "5m", "1h30m". */
	intervalHuman: string;
	/** Optional IANA timezone, e.g. "America/Los_Angeles". Reserved for
	 *  cron-equivalent semantics; ignored by the simple interval scheduler. */
	timezone?: string;
}

/**
 * Cron trigger: fires on a 5-field POSIX cron expression.
 *
 * Fields: `minute hour day-of-month month day-of-week`.
 * Supports `*`, `*\/n`, `a,b,c`, `a-b`. Seconds field, `?`, `L`, `#`
 * are rejected by {@link parseCron}.
 */
export interface CronTrigger {
	kind: "cron";
	/** Raw cron expression, e.g. `"0 9 * * 1-5"`. */
	expr: string;
	/** Optional IANA timezone. Defaults to system local time. */
	timezone?: string;
}

/** One-off trigger: fires once at an absolute timestamp. */
export interface OneOffTrigger {
	kind: "oneoff";
	/** ISO-8601 timestamp. May be UTC (`...Z`) or local-in-`timezone`. */
	fireAtIso: string;
	/** Optional IANA timezone (used when `fireAtIso` has no offset). */
	timezone?: string;
}

/** Lifecycle events a hook routine can subscribe to. */
export type HookEvent = "session_start" | "agent_end" | "session_shutdown";

/** Hook trigger: fires on a pi lifecycle event. */
export interface HookTrigger {
	kind: "hook";
	event: HookEvent;
	/**
	 * Optional firing-frequency guard.
	 * - "daily"       : fire at most once per local calendar day
	 * - "per_session" : fire at most once per pi session
	 */
	once?: "daily" | "per_session";
}

/** Union of all trigger kinds. */
export type RoutineTrigger = PulseTrigger | CronTrigger | OneOffTrigger | HookTrigger;

// ─── Context modes ───────────────────────────────────────────────────────────

/**
 * Context mode controls what conversation history the LLM sees when the
 * routine fires.
 *
 * v1 only supports `"session"` (full current session). `"fresh"` is reserved
 * for v2 (subagent isolation).
 */
export type RoutineContext = "session";

// ─── Routine definition ──────────────────────────────────────────────────────

/** A user-defined routine. Stored in {@link RoutineStore.routines}. */
export interface Routine {
	/** nanoid — stable across renames. Primary key in the store. */
	id: string;
	/** User-facing display name; used by /routine-stop. */
	name: string;
	/** Prompt text sent to the LLM when the routine fires. */
	prompt: string;
	/**
	 * One or more triggers. v1 routines (single `trigger`) are migrated to a
	 * single-element array by {@link migrateV1ToV2}. ANY trigger firing
	 * enqueues the routine once.
	 */
	triggers: RoutineTrigger[];
	context: RoutineContext;
	/** If true, suppress `[~]` "nothing to report" responses in chat. */
	quiet: boolean;
	/** Auto-delete after N fires. `undefined` = unlimited. */
	maxTicks?: number;
	/** Epoch millis of creation. */
	createdAt: number;
}

// ─── Per-routine persisted state ─────────────────────────────────────────────

/** State persisted between ticks for a single routine. */
export interface RoutineTickState {
	/** Number of times this routine has fired. */
	tickCount: number;
	/** Epoch millis of the most recent fire. */
	lastFiredAt: number;
	/** Local ISO date (`YYYY-MM-DD`) of last fire — used by the daily guard. */
	lastFiredDateLocal: string;
	/** Arbitrary LLM-writable state. Capped at {@link MAX_USER_STATE_BYTES}. */
	userState: Record<string, unknown>;
}

// ─── Persisted store shape ───────────────────────────────────────────────────

/** What gets written to state.json. */
export interface RoutineStore {
	/** Persisted store schema version. Files without this field are v1. */
	schemaVersion: typeof SCHEMA_VERSION;
	/** Keyed by {@link Routine.id}. */
	routines: Record<string, Routine>;
	/** Keyed by {@link Routine.id}. */
	tickState: Record<string, RoutineTickState>;
}

// ─── Non-persisted runtime state ─────────────────────────────────────────────

/** In-memory runtime state. Reconstructed on session_start; not persisted. */
export interface RoutineRuntimeState {
	store: RoutineStore;
	/**
	 * routine id → list of active timer handles (one per trigger).
	 * Ordered by trigger index; entries may be `null` for fired-and-spent
	 * one-off triggers.
	 */
	timers: Map<string, Array<ReturnType<typeof setInterval> | null>>;
	/** routine ids waiting for an idle slot (FIFO, deduped). */
	queue: string[];
	/** Recursion guard — set true while a routine turn is in flight. */
	isRoutineTurnActive: boolean;
	/** Name of the currently executing routine (for widget/suppressor labels). */
	activeRoutineName: string | null;
	/** Most recently seen ExtensionContext, for use when firing outside an event. */
	lastUiCtx: ExtensionContext | null;
}

// ─── Parser output ───────────────────────────────────────────────────────────

/** Output of {@link parseInterval}: numeric ms + normalized human string. */
export interface ParsedInterval {
	ms: number;
	/** Normalized form, e.g. "1h30m" for input "90 minutes". */
	human: string;
}

// ─── Template definition (templates/*.json) ──────────────────────────────────

/** JSON shape for a bundled routine template. */
export interface RoutineTemplate {
	/** Template id, e.g. "ci-watch". */
	name: string;
	/** One-line description shown in `/routine-template`. */
	description: string;
	trigger:
		| {
				kind: "pulse";
				/** Human interval string, parsed at install time. */
				interval: string;
		  }
		| {
				kind: "hook";
				event: HookEvent;
				once?: "daily" | "per_session";
		  };
	/** Prompt body. May contain `{cwd}`, `{date}`, `{time}` placeholders. */
	prompt: string;
	quiet: boolean;
	maxTicks?: number;
	/** Tool names to check at install time (warns, does not block). */
	requiredTools?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** The token the LLM emits to signal "nothing to report". */
export const SILENT_TOKEN = "[~]";

/** Max items kept in the fire queue (backpressure). */
export const MAX_QUEUE_DEPTH = 3;

/** Max per-routine userState size in bytes (JSON.stringify). */
export const MAX_USER_STATE_BYTES = 2048;

/** Current persisted-store schema version. v1 had no field; v2 introduces
 *  `triggers: RoutineTrigger[]` and adds `cron` + `oneoff` kinds. */
export const SCHEMA_VERSION = 2 as const;

/** Window within which fires from distinct triggers on the same routine
 *  collapse into a single enqueue (multi-trigger dedup). */
export const MULTI_TRIGGER_COLLAPSE_MS = 500;

/**
 * Absolute path of the persisted state file.
 * Falls back to `/tmp/pi-routines-state.json` when `HOME` is unset.
 */
export const STATE_FILE: string = process.env.HOME
	? `${process.env.HOME}/.pi/agent/extensions/routines/state.json`
	: "/tmp/pi-routines-state.json";

/** Directory containing bundled routine templates. */
export const TEMPLATES_DIR: string = new URL("../templates", import.meta.url).pathname;
