# TP-007: Slash Commands — Status

**Current Step:** Step 0: Preflight
**Status:** 🟡 In Progress
**Last Updated:** 2026-05-20
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 1
**Size:** M

---

### Step 0: Preflight
**Status:** ✅ Complete

- [x] TP-001, TP-002, TP-004, TP-005 all complete (verified: src/{types,parser,store,guard,executor,scheduler}.ts + src/tools/routine-{create,delete,list,set-state}.ts)
- [x] `templates/` directory populated (7 JSON files)

---

### Step 1: Extract `src/tools/_mutate.ts`
**Status:** ✅ Complete

- [x] `createRoutine`, `deleteRoutine`, `resolveRoutine` helpers
- [x] Refactor TP-005 tool files to delegate
- [x] `pnpm typecheck` passes after refactor

---

### Step 2: /routine
**Status:** 🟨 In Progress

- [ ] Interval parsing across multi-word prefix
- [ ] Auto-name + collision suffix
- [ ] Create + confirm

---

### Step 3: /routine-on
**Status:** ⬜ Not Started

- [ ] Event aliases (start/end/stop)
- [ ] Hook trigger creation
- [ ] Reject duplicate `agent_end`

---

### Step 4: /routines
**Status:** ⬜ Not Started

- [ ] Table output with empty-state hint

---

### Step 5: /routine-stop
**Status:** ⬜ Not Started

- [ ] Tab-completion on routine names
- [ ] Delete + confirm

---

### Step 6: /routine-install
**Status:** ⬜ Not Started

- [ ] Tab-completion on template names
- [ ] Sanitize template name input
- [ ] `requiredTools` check via `pi.exec("which", [tool])` — warn only
- [ ] Create routine from template

---

### Step 7: /routine-export-cron
**Status:** ⬜ Not Started

- [ ] Refuse hook routines + interval > 60m
- [ ] Generate crontab line, launchd plist, prompt file
- [ ] Write helper files; do not modify the user's crontab

---

### Step 8: Testing & Verification
**Status:** ⬜ Not Started

- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm test` exits 0
- [ ] No direct `runtime.store.routines[id] =` writes outside `_mutate.ts`

---

### Step 9: Documentation & Delivery
**Status:** ⬜ Not Started

- [ ] JSDoc on every new file
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
| 2026-05-20 00:44 | Task started | Runtime V2 lane-runner execution |
| 2026-05-20 00:44 | Step 0 started | Preflight |

---

## Blockers

*None*

---

## Notes

*Reserved for execution notes*
