# Task: TP-009 — Run History + Manual Fire + `/routine-runs`

**Created:** 2026-05-20
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Bounded scope (state field + 2 commands + 1 widget tweak).
Pattern matches existing tool/command shapes. Plan review confirms run-record
shape and retention policy.

**Score:** 3/8

## Canonical Task Folder

```
taskplane-tasks/TP-009-run-history/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Persist a bounded ring buffer of past runs per routine and expose three new
surfaces:

1. `RoutineRun` records (status, duration, trigger, snippet of first 200
   chars of response, timestamps).
2. Slash command `/routine-run-now <id|name>` — fires a routine immediately,
   bypassing schedule, respecting the `isRoutineTurnActive` guard.
3. Slash command `/routine-runs <id|name> [--limit N]` — prints recent runs.

## Dependencies

- **Task:** TP-008 (multi-trigger; runs need to record which trigger fired)

## Context to Read First

**Tier 2:**

- `taskplane-tasks/CONTEXT.md`

**Tier 3:**

- `src/types.ts` — for `Routine` shape, `RoutineRuntimeState`
- `src/executor.ts` — where each routine turn starts/ends; the natural place
  to record a `RoutineRun`
- `src/scheduler.ts` — the queue + executor entrypoint
- `src/commands/routine-stop.ts` — pattern for resolving id-or-name
- `src/commands/routines.ts` — pattern for listing

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, ESM, TypeScript strict

## File Scope

- `src/types.ts` (modify — add `RoutineRun` and `runs` array on tickState)
- `src/store.ts` (modify — cap `runs` to 20 most recent on save)
- `src/executor.ts` (modify — wrap turn in record-run hook)
- `src/commands/routine-run-now.ts` (new)
- `src/commands/routine-runs.ts` (new)
- `extensions/index.ts` (modify — register the two new commands)
- `tests/run-history.test.ts` (new)

## Steps

### Step 0: Preflight

- [ ] TP-008 is `.DONE` (or local branch contains its commit)
- [ ] `pnpm check` green on base

### Step 1: Types — `RoutineRun`

- [ ] Add to `src/types.ts`:
      `ts
    export interface RoutineRun {
      id: string;             // nanoid
      routineId: string;
      startedAt: number;
      endedAt: number;
      durationMs: number;
      status: "success" | "error" | "skipped" | "silent";
      triggerIndex: number;   // which of routine.triggers fired
      triggerKind: RoutineTrigger["kind"];
      snippet: string;        // first 200 chars of response, or error msg
    }
    `
- [ ] Add `runs: RoutineRun[]` to `RoutineTickState`
- [ ] Export `MAX_RUN_HISTORY = 20`

### Step 2: Executor hook

- [ ] In `src/executor.ts`, wrap the LLM-turn submission:
  - capture `startedAt`
  - on response or error, compute `endedAt` + `durationMs`
  - classify `status`:
    - `silent` if response trimmed === `[~]` (quiet routine)
    - `success` otherwise normally
    - `error` if the turn threw
    - `skipped` if the guard prevented execution
  - push the `RoutineRun` into `runtime.store.tickState[routineId].runs`,
    trim to `MAX_RUN_HISTORY`
  - call `saveStore` (debounced — once per second is fine)

### Step 3: `/routine-run-now <id|name>`

- [ ] Register via `pi.registerCommand`
- [ ] Resolve id-or-name → routine
- [ ] If `runtime.isRoutineTurnActive` → error: "another routine is running"
- [ ] Otherwise enqueue the routine via the scheduler's enqueue helper
      with `triggerIndex: -1` (sentinel for "manual")
- [ ] `triggerKind: "manual"` — add this to the discriminated union OR
      represent it via `triggerIndex: -1` and a virtual `RoutineTrigger`
      with `kind: "manual"`. Pick one and document.

### Step 4: `/routine-runs <id|name> [--limit N]`

- [ ] Default `--limit 5`, max 20
- [ ] Output a table: `time · trigger · status · duration · snippet`
- [ ] Color status (green/red/grey)
- [ ] Returns "no runs yet" if list empty

### Step 5: Widget + tests

- [ ] Footer widget shows `last status` per routine (✓/✗/~) — small change
      to `src/widget.ts`
- [ ] `tests/run-history.test.ts` — synthetic fire-twice scenario verifies
      bounded history, trim semantics, status classification
- [ ] `pnpm check` green

## Definition of Done

- [ ] All steps' checkboxes green
- [ ] `pnpm check` exits 0
- [ ] `/routine-run-now` fires within 1s of invocation (manual smoke test
      noted in STATUS.md)
- [ ] Commit message: `feat(history): run records, /routine-run-now,
    /routine-runs (TP-009)`
- [ ] `.DONE` + STATUS.md written
