# TP-001: Foundation — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-19
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 0
**Size:** M

> **Hydration:** Outcome-level checkboxes. Worker expands within a step only
> if runtime discoveries reveal additional distinct outcomes.

---

### Step 0: Preflight
**Status:** ⬜ Not Started

- [ ] PLAN.md exists at repo root
- [ ] `src/` directory is empty
- [ ] `pnpm` available

---

### Step 1: Package skeleton
**Status:** ⬜ Not Started

- [ ] Create `package.json` with pi extension config and deps
- [ ] Create `tsconfig.json` (strict, ESM, bundler resolution)
- [ ] `pnpm install` succeeds
- [ ] `pnpm typecheck` passes (no source yet)

---

### Step 2: src/types.ts
**Status:** ⬜ Not Started

- [ ] Define all shared types from PLAN.md Phase 1
- [ ] Export constants (`SILENT_TOKEN`, limits, paths)
- [ ] JSDoc on every exported symbol

---

### Step 3: src/parser.ts
**Status:** ⬜ Not Started

- [ ] Implement `parseInterval` supporting all formats from PLAN.md Phase 3
- [ ] Implement all four rejection cases with clear messages
- [ ] Optional inline test block guarded by `import.meta.main`

---

### Step 4: src/store.ts
**Status:** ⬜ Not Started

- [ ] Implement `loadStore` (fault-tolerant, never throws)
- [ ] Implement `saveStore` (atomic write + `.bak`)
- [ ] Handle missing HOME / permission / disk-full cases gracefully

---

### Step 5: src/guard.ts
**Status:** ⬜ Not Started

- [ ] Implement `acquireRoutineTurn` / `releaseRoutineTurn` / `isRoutineTurnActive`
- [ ] Implement `shouldFireHook` (daily/per-session logic)
- [ ] JSDoc explaining the three-level guard strategy

---

### Step 6: Testing & Verification
**Status:** ⬜ Not Started

- [ ] `pnpm install` succeeds
- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm test` exits 0 (placeholder)

---

### Step 7: Documentation & Delivery
**Status:** ⬜ Not Started

- [ ] Discoveries logged in `taskplane-tasks/CONTEXT.md`
- [ ] File-header JSDoc on all four modules

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
