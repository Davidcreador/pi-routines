/**
 * @file store.ts — atomic, fault-tolerant persistence of {@link RoutineStore}.
 *
 * Reads/writes `${HOME}/.pi/agent/extensions/routines/state.json` (falls back
 * to `/tmp/pi-routines-state.json` when HOME is unset).
 *
 * Design rules:
 * - {@link loadStore} never throws. Missing / corrupt / unreadable file all
 *   resolve to an empty store; corruption is logged once to stderr.
 * - {@link saveStore} writes atomically (`.tmp` + rename) and additionally
 *   produces a `.bak` copy after successful rename. Disk-full / permission
 *   errors are caught and logged — never thrown — because in-memory state is
 *   the authoritative source.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { RoutineStore, RoutineTrigger } from "./types.ts";
import { SCHEMA_VERSION, STATE_FILE } from "./types.ts";

/** Fresh, empty store. */
export function emptyStore(): RoutineStore {
	return { schemaVersion: SCHEMA_VERSION, routines: {}, tickState: {} };
}

/**
 * One-way migration from v1 (no `schemaVersion`, `trigger: RoutineTrigger`)
 * to v2 (`schemaVersion: 2`, `triggers: RoutineTrigger[]`).
 *
 * - Wraps each routine's singular `trigger` into a single-element
 *   `triggers` array.
 * - Drops the old `trigger` field.
 * - Idempotent: if already v2, returns the input unchanged.
 */
export function migrateV1ToV2(raw: unknown): RoutineStore {
	const empty = emptyStore();
	if (!raw || typeof raw !== "object") return empty;
	const obj = raw as Record<string, unknown>;

	const routinesIn = (obj.routines ?? {}) as Record<string, Record<string, unknown>>;
	const routinesOut: Record<string, Record<string, unknown>> = {};
	for (const [id, r] of Object.entries(routinesIn)) {
		if (!r || typeof r !== "object") continue;
		let triggers: RoutineTrigger[];
		if (Array.isArray(r.triggers)) {
			triggers = r.triggers as RoutineTrigger[];
		} else if (r.trigger && typeof r.trigger === "object") {
			triggers = [r.trigger as RoutineTrigger];
		} else {
			triggers = [];
		}
		const { trigger: _drop, ...rest } = r as { trigger?: unknown } & Record<string, unknown>;
		routinesOut[id] = { ...rest, triggers };
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		routines: routinesOut as unknown as RoutineStore["routines"],
		tickState: (obj.tickState ?? {}) as RoutineStore["tickState"],
	};
}

/**
 * Load the persisted store.
 *
 * Returns {@link emptyStore} for any failure mode (missing file, malformed
 * JSON, permission denied). Never throws. Logs a single warning to stderr
 * on corruption recovery so the operator can investigate.
 */
export async function loadStore(): Promise<RoutineStore> {
	let raw: string;
	try {
		raw = await fs.readFile(STATE_FILE, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(
				`[pi-routines] could not read state.json (${code ?? "unknown"}): ${(err as Error).message}`,
			);
		}
		return emptyStore();
	}

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const version = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
		if (version >= SCHEMA_VERSION) {
			return {
				schemaVersion: SCHEMA_VERSION,
				routines: (parsed.routines ?? {}) as RoutineStore["routines"],
				tickState: (parsed.tickState ?? {}) as RoutineStore["tickState"],
			};
		}
		// v1 → v2: back up raw, write migrated atomically.
		const migrated = migrateV1ToV2(parsed);
		try {
			await fs.mkdir(dirname(STATE_FILE), { recursive: true });
			await fs.writeFile(`${STATE_FILE}.v1.bak`, raw, "utf8");
		} catch (err) {
			console.warn(`[pi-routines] could not write .v1.bak: ${(err as Error).message}`);
		}
		await saveStore(migrated);
		console.warn("[pi-routines] migrated state.json to v2");
		return migrated;
	} catch (err) {
		console.warn(`[pi-routines] state.json corrupt, starting fresh: ${(err as Error).message}`);
		return emptyStore();
	}
}

/**
 * Persist the store atomically.
 *
 * Sequence:
 *   1. mkdir -p on the parent directory.
 *   2. Serialize the store (under the same try block, so a JSON error doesn't
 *      become an unhandled promise rejection from fire-and-forget callers).
 *   3. Write JSON to a UNIQUE per-call `.tmp.<rand>` file. Unique names are
 *      load-bearing — multiple call sites do `void saveStore(...)`
 *      (recordRun, the oneoff fired-flag callback, etc.), and with a single
 *      shared tmp filename two concurrent writers either interleave bytes
 *      into the same file or trip ENOENT when one rename consumes the
 *      inode the other expected.
 *   4. `fs.rename` → final path (atomic on POSIX). Concurrent renames to
 *      the same target are still "last writer wins" — semantically the
 *      same as in-memory: the latest snapshot is what persists.
 *   5. Copy final → `${STATE_FILE}.bak` for disaster recovery.
 *
 * Any I/O error (disk full, EACCES, etc.) is caught and logged. The caller's
 * in-memory state remains the source of truth.
 */
export async function saveStore(store: RoutineStore): Promise<void> {
	const tmp = `${STATE_FILE}.tmp.${randomBytes(4).toString("hex")}`;
	const bak = `${STATE_FILE}.bak`;

	try {
		const data = JSON.stringify(store, null, 2);
		await fs.mkdir(dirname(STATE_FILE), { recursive: true });
		await fs.writeFile(tmp, data, "utf8");
		await fs.rename(tmp, STATE_FILE);
		try {
			await fs.copyFile(STATE_FILE, bak);
		} catch (err) {
			console.warn(`[pi-routines] could not write .bak: ${(err as Error).message}`);
		}
	} catch (err) {
		console.warn(
			`[pi-routines] saveStore failed (${(err as NodeJS.ErrnoException).code ?? "unknown"}): ${(err as Error).message}`,
		);
		// Best-effort cleanup of our own tmp file. Other concurrent
		// writers have their own tmp filenames so they're not affected.
		try {
			await fs.unlink(tmp);
		} catch {
			/* ignore */
		}
	}
}
