# TP-005: Tools — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-19
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 0
**Size:** M

---

### Step 0: Preflight
**Status:** ⬜ Not Started

- [ ] TP-001 and TP-002 complete

---

### Step 1: routine-create.ts
**Status:** ⬜ Not Started

- [ ] TypeBox schema with pulse/hook union
- [ ] All validation cases (name regex, interval parse, agent_end uniqueness, 20-routine cap)
- [ ] Upsert semantics for existing name
- [ ] Schedule pulse on success

---

### Step 2: routine-list.ts
**Status:** ⬜ Not Started

- [ ] Sorted list with relative timestamps
- [ ] Table-formatted `renderResult`

---

### Step 3: routine-delete.ts
**Status:** ⬜ Not Started

- [ ] id-then-name resolution
- [ ] Helpful error with current routine list on not-found
- [ ] Unschedule + remove + save

---

### Step 4: routine-set-state.ts
**Status:** ⬜ Not Started

- [ ] Deep merge into `userState`
- [ ] 2KB size guard
- [ ] Save store

---

### Step 5: Testing & Verification
**Status:** ⬜ Not Started

- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm test` exits 0
- [ ] JSDoc on all four files

---

### Step 6: Documentation & Delivery
**Status:** ⬜ Not Started

- [ ] Discoveries logged in CONTEXT.md
- [ ] `_resolve.ts` helper noted if extracted

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

*Reserved for execution notes*
