# Task: TP-001 — Foundation: types, store, parser, guard, build config

**Created:** 2026-05-19
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Foundation task — every downstream task imports from `src/types.ts`,
so the shapes need a plan review before the rest of the system is built on top.
Logic itself is mechanical (file I/O, regex parsing).

**Score:** 2/8 — Blast radius: 1 (single package, but downstream tasks depend on these contracts), Pattern novelty: 1 (new module, existing patterns from pi-subagents to draw on), Security: 0, Reversibility: 0 (easy to revise pre-publish)

## Canonical Task Folder

```
taskplane-tasks/TP-001-foundation/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Build the foundation layer of pi-routines: type definitions, persistent store,
interval parser, recursion guard primitives, and the npm package skeleton
(`package.json`, `tsconfig.json`). Every later task in this batch depends on
the shapes and helpers established here.

## Dependencies

- **None**

## Context to Read First

**Tier 3 (load only as needed):**
- `PLAN.md` — Phases 1–4 (Types, Store, Parser, Guard), and the Edge Case Matrix.
  These four phases are the entire scope of this task.

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Services required:** None
- **Runtime:** Node 22+, ESM, TypeScript strict mode

## File Scope

- `package.json` (new)
- `tsconfig.json` (new)
- `src/types.ts` (new)
- `src/store.ts` (new)
- `src/parser.ts` (new)
- `src/guard.ts` (new)

## Steps

### Step 0: Preflight

- [ ] `PLAN.md` exists at repo root
- [ ] `src/` directory is empty (this task creates the foundation)
- [ ] `pnpm` is available

### Step 1: Package skeleton

- [ ] Create `package.json` with:
  - `"name": "pi-routines"`, `"version": "0.1.0"`, `"type": "module"`
  - `"pi": { "extensions": ["./extensions/index.ts"], "skills": ["./skills"] }`
  - `peerDependencies`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (both `"*"`)
  - `dependencies`: `typebox` (`^1.0.0`), `nanoid` (`^5.0.0`)
  - `devDependencies`: `typescript` (`^5.6.0`), `@types/node` (`^22.0.0`)
  - Scripts: `"typecheck": "tsc --noEmit"`, `"test": "echo 'no tests yet' && exit 0"`
- [ ] Create `tsconfig.json` targeting `ES2022`, `module: "ESNext"`,
  `moduleResolution: "Bundler"`, `strict: true`, `noEmit: true`,
  `verbatimModuleSyntax: true`. Include `src/**/*` and `extensions/**/*`.
- [ ] Run `pnpm install` — must succeed (peers may warn, that's fine)
- [ ] Run `pnpm typecheck` — passes (no source yet, only config validated)

**Artifacts:**
- `package.json` (new)
- `tsconfig.json` (new)

### Step 2: `src/types.ts` — single source of truth

Implement exactly as specified in `PLAN.md` Phase 1. All shared types live
here. Other modules MUST import shapes from this file.

- [ ] Export all types: `RoutineTier`, `PulseTrigger`, `HookEvent`, `HookTrigger`,
  `RoutineTrigger`, `RoutineContext`, `Routine`, `RoutineTickState`,
  `RoutineStore`, `RoutineRuntimeState`, `ParsedInterval`, `RoutineTemplate`
- [ ] Export constants: `SILENT_TOKEN = "[~]"`, `MAX_QUEUE_DEPTH = 3`,
  `MAX_USER_STATE_BYTES = 2048`, `STATE_FILE` (resolves to
  `${HOME}/.pi/agent/extensions/routines/state.json` with `/tmp` fallback when
  `HOME` is unset), `TEMPLATES_DIR` (relative to this package, resolved via
  `new URL("../templates", import.meta.url).pathname`)
- [ ] `RoutineRuntimeState.lastUiCtx` is typed as
  `import("@earendil-works/pi-coding-agent").ExtensionContext | null`
- [ ] Add JSDoc comments on every exported type explaining its purpose. These
  comments are the contract downstream tasks read.
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/types.ts` (new)

### Step 3: `src/parser.ts` — interval string → ms

Implement exactly as specified in `PLAN.md` Phase 3.

- [ ] Export `parseInterval(input: string): ParsedInterval`
- [ ] Support: `"30s"`, `"5m"`, `"1h"`, `"1h30m"`, `"2h 15m"`, `"25 minutes"`,
  `"1 hour"`, leading `"every "` stripped
- [ ] Reject with clear `Error` messages:
  - Less than 30s: `"Interval must be at least 30 seconds"`
  - No unit: `"Specify a unit: 5s, 5m, or 5h"`
  - Over 24h: `"Intervals over 24h should use /routine-export-cron instead"`
  - Unparseable: `"Could not parse interval: '<input>'. Examples: 5m, 1h, 90s"`
- [ ] Return normalized `.human` (e.g., `"1h30m"` for input `"90 minutes"`,
  `"5m"` for input `"every 5m"`)
- [ ] Add inline unit tests using `node:test` runner OR table-driven inline
  assertions guarded by `if (import.meta.main)`. Keep it lightweight — this is
  not a full test suite, just confidence in the parsing edges.
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/parser.ts` (new)

### Step 4: `src/store.ts` — atomic persistence

Implement exactly as specified in `PLAN.md` Phase 2.

- [ ] Export `loadStore(): Promise<RoutineStore>`
- [ ] Export `saveStore(store: RoutineStore): Promise<void>`
- [ ] Export `emptyStore(): RoutineStore`
- [ ] `loadStore` is fault-tolerant: returns `emptyStore()` on missing file,
  corrupt JSON, or unreadable file. Logs a single warning to stderr on
  corruption recovery. Never throws.
- [ ] `saveStore` performs atomic write: write to `${STATE_FILE}.tmp`, then
  `fs.rename` to final path. Also writes a `.bak` copy after successful rename
  for disaster recovery.
- [ ] Creates parent directory (`mkdir -p`) if missing.
- [ ] Falls back to `/tmp/pi-routines-state.json` if `HOME` unset.
- [ ] Catches disk-full or permission errors on write; logs to stderr; does NOT
  throw. (Caller's in-memory state remains the source of truth.)
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/store.ts` (new)

### Step 5: `src/guard.ts` — recursion guard primitives

Implement the data structure and helpers described in `PLAN.md` Phase 6. This
module owns NO direct event subscriptions — it provides pure helpers that
`hooks.ts` (TP-006) will call.

- [ ] Export `acquireRoutineTurn(runtime, routineName): void` — sets
  `isRoutineTurnActive = true`, `activeRoutineName = name`. Throws if already
  active (defense-in-depth — should never happen with a sequential queue).
- [ ] Export `releaseRoutineTurn(runtime): void` — resets both flags.
- [ ] Export `isRoutineTurnActive(runtime): boolean` — simple getter.
- [ ] Export `shouldFireHook(routine, tickState): boolean` — implements the
  `once: "daily"` and `once: "per_session"` logic. Uses
  `new Date().toLocaleDateString("en-CA")` (ISO `YYYY-MM-DD`) for the daily
  comparison.
- [ ] Add JSDoc explaining the three-level guard strategy (flag + input source
  tagging + depth check) and what `hooks.ts` is expected to do.
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/guard.ts` (new)

### Step 6: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

- [ ] `pnpm install` succeeds
- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm test` passes (placeholder script — should just exit 0)
- [ ] Imports between the four files compile cleanly (e.g., `store.ts` and
  `parser.ts` both import from `./types.js`)

### Step 7: Documentation & Delivery

- [ ] Append a short "Foundation done" section to `taskplane-tasks/CONTEXT.md`
  under Discoveries Log noting any deviations from `PLAN.md` Phases 1–4
- [ ] All four `.ts` files have file-header JSDoc explaining their role
- [ ] No `any` types except at strict external boundaries (justified inline if used)

## Documentation Requirements

**Must Update:**
- `taskplane-tasks/CONTEXT.md` — Discoveries table (any deviations from plan)

**Check If Affected:**
- `PLAN.md` — Do not modify. If a planned shape proves wrong during impl, add an
  Amendment to this PROMPT.md instead and proceed; downstream tasks will pick
  up the actual exported shapes.

## Completion Criteria

- [ ] All steps complete
- [ ] `pnpm typecheck` zero errors
- [ ] All four source files exist and export the contracts listed above
- [ ] `package.json` and `tsconfig.json` valid

## Git Commit Convention

- **Step completion:** `feat(TP-001): complete Step N — description`
- **Bug fixes:** `fix(TP-001): description`
- **Hydration:** `hydrate: TP-001 expand Step N checkboxes`

## Do NOT

- Implement executor, scheduler, suppressor, widget, hooks, tools, commands, or
  templates — those are separate tasks (TP-002 through TP-007)
- Add runtime dependencies beyond `typebox` and `nanoid`
- Use `any` without inline justification
- Skip the atomic write / `.bak` logic in `saveStore`
- Modify `PLAN.md`

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues are discovered during execution. -->
