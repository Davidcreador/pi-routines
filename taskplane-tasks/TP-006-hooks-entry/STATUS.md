# TP-006: Hooks & Entry Point — Status

**Current Step:** Step 1: src/hooks.ts
**Status:** 🟡 In Progress
**Last Updated:** 2026-05-20
**Review Level:** 2
**Review Counter:** 1
**Iteration:** 1
**Size:** M

---

### Step 0: Preflight
**Status:** ✅ Complete

- [x] TP-001, TP-002, TP-003, TP-005, TP-007 all complete
- [x] Reference impl `pi-subagents/src/extension/index.ts` readable

---

### Step 1: src/hooks.ts
**Status:** 🟨 In Progress

- [x] `session_start` handler with daily/per-session guards
- [x] `agent_end` handler with recursion guard release + at-most-one hook
- [x] `session_shutdown` handler with reload-skip for shutdown hooks
- [x] `registerInputTracker` for source tagging

---

### Step 2: extensions/index.ts
**Status:** 🟨 In Progress

- [x] Hot-reload cleanup via `globalThis` store key
- [x] Single runtime instance
- [x] Register order: tools → commands → suppressor → hooks
- [x] Print-mode short-circuit (no timers, no widget)

---

### Step 3: Edge case verification walk-through
**Status:** ✅ Complete

- [x] Hot reload — `globalThis.__piRoutinesCleanup` runs on re-load; `session_shutdown(reason: "reload")` skips hooks + saves store; new `session_start(reason: "reload")` reloads from disk.
- [x] Mid-stream queue — scheduler dedups + caps, `drainQueue` gates on `isIdle`/`hasPendingMessages`/guard. `agent_end` calls `drainQueue` after release.
- [x] Multi-session caveat documented in CONTEXT.md (last-write-wins via atomic rename).
- [x] `maxTicks: 1` — executor checks BEFORE acquiring guard, deletes routine + tickState, saves store. (TP-002.)
- [x] Self-deletion (`deploy-watch`) — tool delete runs inside routine turn; guard blocks `agent_end` hooks, drainQueue handles next pulse cleanly.
- [x] Shutdown with pending queue — `stopScheduler` clears queue first, then hooks fire. Documented: shutdown hooks must not `RoutineCreate`.
- [x] Once-daily TZ shift — `lastFiredDateLocal` (en-CA local) changes with TZ; routine fires once more. Acceptable.
- [x] Corrupt state recovery — `loadStore` returns empty store + logs once; `.bak` exists for manual recovery.
- [x] Print mode — `session_start` short-circuits when `!ctx.hasUI`; tools registered, no timers/hooks/widget.

---

### Step 4: Testing & Verification
**Status:** 🟨 In Progress

- [x] `pnpm typecheck` zero errors
- [x] `pnpm test` exits 0 (placeholder `echo` script per package.json)
- [x] Manual smoke test — skipped (sandboxed orchestrated run; no live pi binary). Recorded in Notes.

---

### Step 5: Documentation & Delivery
**Status:** 🟨 In Progress

- [x] `README.md` at repo root
- [x] JSDoc on both new modules
- [x] CONTEXT.md Discoveries updated

---

## Reviews

| # | Type | Step | Verdict | File |
|---|------|------|---------|------|

---

## Discoveries

| Discovery | Disposition | Location |
|-----------|-------------|----------|

---

## Execution Log

| Timestamp | Action | Outcome |
|-----------|--------|---------|
| 2026-05-19 | Task staged | PROMPT.md and STATUS.md created |
| 2026-05-20 00:55 | Task started | Runtime V2 lane-runner execution |
| 2026-05-20 00:55 | Step 0 started | Preflight |

---

## Blockers

*None*

---

## Notes

- Manual smoke test (install via `~/.pi/agent/settings.json` → `/routine 30s say hi` … → restore backup) deferred: orchestrated lane has no interactive pi binary. README documents the install path. `pnpm typecheck` is the green gate.
- Tagging `v0.1.0` candidate is symbolic only — PROMPT explicitly says "do not actually publish to npm"; no `git tag` was created (out of scope for a worker commit).
| 2026-05-20 00:58 | Review R001 | plan Step 1: APPROVE |
