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

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { STATE_FILE } from "./types.ts";
import type { RoutineStore } from "./types.ts";

/** Fresh, empty store. */
export function emptyStore(): RoutineStore {
	return { routines: {}, tickState: {} };
}

/**
 * Load the persisted store.
 *
 * Returns {@link emptyStore} for any failure mode (missing file, malformed
 * JSON, permission denied). Never throws. Logs a single warning to stderr
 * on corruption recovery so the operator can investigate.
 */
export async function loadStore(): Promise<RoutineStore> {
	try {
		const raw = await fs.readFile(STATE_FILE, "utf8");
		try {
			const parsed = JSON.parse(raw) as Partial<RoutineStore>;
			return {
				routines: parsed.routines ?? {},
				tickState: parsed.tickState ?? {},
			};
		} catch (err) {
			console.warn(
				`[pi-routines] state.json corrupt, starting fresh: ${(err as Error).message}`,
			);
			return emptyStore();
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(
				`[pi-routines] could not read state.json (${code ?? "unknown"}): ${(err as Error).message}`,
			);
		}
		return emptyStore();
	}
}

/**
 * Persist the store atomically.
 *
 * Sequence:
 *   1. mkdir -p on the parent directory.
 *   2. Write JSON to `${STATE_FILE}.tmp`.
 *   3. `fs.rename` → final path (atomic on POSIX).
 *   4. Copy final → `${STATE_FILE}.bak` for disaster recovery.
 *
 * Any I/O error (disk full, EACCES, etc.) is caught and logged. The caller's
 * in-memory state remains the source of truth.
 */
export async function saveStore(store: RoutineStore): Promise<void> {
	const data = JSON.stringify(store, null, 2);
	const tmp = `${STATE_FILE}.tmp`;
	const bak = `${STATE_FILE}.bak`;

	try {
		await fs.mkdir(dirname(STATE_FILE), { recursive: true });
		await fs.writeFile(tmp, data, "utf8");
		await fs.rename(tmp, STATE_FILE);
		try {
			await fs.copyFile(STATE_FILE, bak);
		} catch (err) {
			console.warn(
				`[pi-routines] could not write .bak: ${(err as Error).message}`,
			);
		}
	} catch (err) {
		console.warn(
			`[pi-routines] saveStore failed (${(err as NodeJS.ErrnoException).code ?? "unknown"}): ${(err as Error).message}`,
		);
		// Best-effort cleanup of stale tmp file.
		try {
			await fs.unlink(tmp);
		} catch {
			/* ignore */
		}
	}
}
