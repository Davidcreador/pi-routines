# Task: TP-005 — LLM-callable Tools

**Created:** 2026-05-19
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Four tool implementations following the well-established Pi
tool pattern (TypeBox schema + execute + renderCall/renderResult). Plan review
to confirm schemas; execute logic is mechanical.

**Score:** 2/8 — Blast radius: 1 (the routine surface the LLM sees), Pattern
novelty: 1 (matches existing Pi tools), Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-005-tools/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Implement the four LLM-callable tools exposed by pi-routines:
`RoutineCreate`, `RoutineList`, `RoutineDelete`, `RoutineSetState`. Each is a
self-contained `ToolDefinition` exported from its own file. They share access
to the `RoutineRuntimeState` and helpers from TP-001/TP-002.

## Dependencies

- **Task:** TP-001 (types, store, parser, guard)
- **Task:** TP-002 (scheduler functions: `scheduleRoutine`, `unscheduleRoutine`)

## Context to Read First

**Tier 2:**
- `taskplane-tasks/CONTEXT.md`

**Tier 3:**
- `PLAN.md` — Phase 10 (Tools)
- `src/types.ts` — for all shared shapes
- `src/parser.ts` — for `parseInterval` (RoutineCreate uses this)
- `src/scheduler.ts` — for `scheduleRoutine` / `unscheduleRoutine` (Create/Delete)
- `src/store.ts` — for `saveStore` (every mutation persists)

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, ESM, TypeScript strict

## File Scope

- `src/tools/routine-create.ts` (new)
- `src/tools/routine-list.ts` (new)
- `src/tools/routine-delete.ts` (new)
- `src/tools/routine-set-state.ts` (new)

## Steps

### Step 0: Preflight

- [ ] TP-001 and TP-002 are complete (both `.DONE` files exist)
- [ ] Scheduler exports compile (try a dummy import in a scratch file)

### Step 1: `src/tools/routine-create.ts`

Implement per `PLAN.md` Phase 10 (RoutineCreate section).

- [ ] Export `registerRoutineCreateTool(pi, runtime): void` that calls
  `pi.registerTool(...)` with a `ToolDefinition`
- [ ] TypeBox schema with union over pulse/hook trigger
- [ ] Validation in `execute`:
  - Name matches `/^[a-z0-9-]{1,32}$/` — return error if not
  - Pulse interval: call `parseInterval`, catch and return error message
  - Hook `agent_end`: scan `runtime.store.routines` for any existing
    `agent_end` hook (other than one with the same name being updated).
    Reject if found.
  - Total active routine count >= 20: reject with limit message
- [ ] On success:
  - If name already exists: update (preserve `id`, `createdAt`, `tickState`).
    Unschedule the old pulse if interval changed.
  - Else: generate `nanoid` id, set `createdAt = Date.now()`, initialize
    `tickState` to `{ tickCount: 0, lastFiredAt: 0, lastFiredDateLocal: "", userState: {} }`
  - Persist via `saveStore`
  - If pulse trigger: call `scheduleRoutine`
  - Return result with `id`, `name`, `triggerDescription`, and (for pulse)
    `nextFireIn` as a humanized duration
- [ ] `renderCall`: one-liner like `subagent <action>` style — show name + trigger summary
- [ ] `renderResult`: minimal — just confirmation text
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/tools/routine-create.ts` (new)

### Step 2: `src/tools/routine-list.ts`

- [ ] Export `registerRoutineListTool(pi, runtime): void`
- [ ] Empty params schema (`Type.Object({})`)
- [ ] `execute` returns sorted list of routines (alphabetical by name) with:
  `{ id, name, triggerDescription, tickCount, lastFiredAt, quiet, maxTicks? }`
- [ ] `triggerDescription` examples:
  - `"every 5m"` for pulse
  - `"on session_start (daily)"` for hook
- [ ] `lastFiredAt` rendered as relative ("2 minutes ago", "never", "yesterday")
- [ ] `renderResult` returns a Text component formatted as a column-aligned table
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/tools/routine-list.ts` (new)

### Step 3: `src/tools/routine-delete.ts`

- [ ] Export `registerRoutineDeleteTool(pi, runtime): void`
- [ ] Schema: `{ id?: string, name?: string }` — neither is `required`, but
  `execute` returns an error if both are absent
- [ ] Resolution order: `id` first (exact match), then `name`
  (case-insensitive match against `routine.name`)
- [ ] Not found: return error message including the current list of routine
  names so the LLM can correct itself
- [ ] On success:
  - `unscheduleRoutine` if pulse
  - Delete from `routines` and `tickState`
  - `saveStore`
  - Return `{ deletedId, deletedName }`
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/tools/routine-delete.ts` (new)

### Step 4: `src/tools/routine-set-state.ts`

- [ ] Export `registerRoutineSetStateTool(pi, runtime): void`
- [ ] Schema: `{ id?: string, name?: string, state: Record<string, unknown> }`
- [ ] Resolve routine by id-then-name (same logic as Delete; consider extracting
  to a tiny helper in `src/tools/_resolve.ts` if reused — fine to inline if not)
- [ ] **Deep merge** `state` into existing `tickState.userState`. Use a small
  inline recursive merge: objects merge by key; arrays and primitives replace.
- [ ] Validate merged size: `JSON.stringify(merged).length <= MAX_USER_STATE_BYTES`.
  If too large, return error with current size and limit, do NOT mutate.
- [ ] On success: `saveStore`, return `{ id, name, stateSize: merged.length }`
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/tools/routine-set-state.ts` (new)

### Step 5: Testing & Verification

> ZERO failures.

- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm test` exits 0
- [ ] All four tools have non-trivial JSDoc on the exported register fn
  explaining what the tool does and when the LLM should call it (these JSDocs
  may be the description text the LLM ultimately sees — the description field
  in the ToolDefinition object is the actual source of truth, this JSDoc is
  for the human readers)

### Step 6: Documentation & Delivery

- [ ] File-header JSDoc on each of the four files
- [ ] Discoveries logged in `taskplane-tasks/CONTEXT.md`
- [ ] If `_resolve.ts` helper was added, mention it in Discoveries

## Documentation Requirements

**Must Update:**
- `taskplane-tasks/CONTEXT.md` — Discoveries table

**Check If Affected:**
- `PLAN.md` — do not modify; log via Amendment

## Completion Criteria

- [ ] All 4 tool files exist with their register functions exported
- [ ] `pnpm typecheck` zero errors

## Git Commit Convention

- **Step completion:** `feat(TP-005): complete Step N — description`
- **Bug fixes:** `fix(TP-005): description`

## Do NOT

- Write event-loop logic — these are pure tool definitions
- Touch `src/hooks.ts` or `extensions/index.ts` (those are TP-006)
- Implement slash commands here (those are TP-007)
- Skip the deep-merge logic in RoutineSetState (`Object.assign` would replace
  nested objects and lose state)
- Skip the 20-routine cap or the 2KB userState cap

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues are discovered during execution. -->
