# TP-006: Hooks & Entry Point — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-19
**Review Level:** 2
**Review Counter:** 0
**Iteration:** 0
**Size:** M

---

### Step 0: Preflight
**Status:** ⬜ Not Started

- [ ] TP-001, TP-002, TP-003, TP-005, TP-007 all complete
- [ ] Reference impl `pi-subagents/src/extension/index.ts` readable

---

### Step 1: src/hooks.ts
**Status:** ⬜ Not Started

- [ ] `session_start` handler with daily/per-session guards
- [ ] `agent_end` handler with recursion guard release + at-most-one hook
- [ ] `session_shutdown` handler with reload-skip for shutdown hooks
- [ ] `registerInputTracker` for source tagging

---

### Step 2: extensions/index.ts
**Status:** ⬜ Not Started

- [ ] Hot-reload cleanup via `globalThis` store key
- [ ] Single runtime instance
- [ ] Register order: tools → commands → suppressor → hooks
- [ ] Print-mode short-circuit (no timers, no widget)

---

### Step 3: Edge case verification walk-through
**Status:** ⬜ Not Started

- [ ] Hot reload
- [ ] Mid-stream queue
- [ ] Multi-session caveat documented
- [ ] `maxTicks: 1`
- [ ] Self-deletion (`deploy-watch`)
- [ ] Shutdown with pending queue
- [ ] Once-daily TZ shift
- [ ] Corrupt state recovery
- [ ] Print mode

---

### Step 4: Testing & Verification
**Status:** ⬜ Not Started

- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm test` exits 0
- [ ] Manual smoke test recorded in Notes

---

### Step 5: Documentation & Delivery
**Status:** ⬜ Not Started

- [ ] `README.md` at repo root
- [ ] JSDoc on both new modules
- [ ] CONTEXT.md Discoveries updated

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

---

## Blockers

*None*

---

## Notes

*Reserved for execution notes — record smoke-test outcomes here*
