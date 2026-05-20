/**
 * @file _resolve.ts — shared id/name resolution helper for tools.
 *
 * Used by routine-delete and routine-set-state to look up a routine by
 * `id` first (exact match) and then by `name` (case-insensitive). Returns
 * null if neither matches.
 */

import type { Routine, RoutineStore } from "../types.ts";

/**
 * Resolve a routine by id first (exact), then by case-insensitive name.
 * Returns `null` if neither identifier matches.
 */
export function resolveRoutine(
	store: RoutineStore,
	id?: string,
	name?: string,
): Routine | null {
	if (id) {
		const byId = store.routines[id];
		if (byId) return byId;
	}
	if (name) {
		const lower = name.toLowerCase();
		for (const r of Object.values(store.routines)) {
			if (r.name.toLowerCase() === lower) return r;
		}
	}
	return null;
}

/** Comma-separated list of current routine names (for "not found" errors). */
export function listRoutineNames(store: RoutineStore): string {
	const names = Object.values(store.routines)
		.map((r) => r.name)
		.sort();
	return names.length === 0 ? "(none)" : names.join(", ");
}
