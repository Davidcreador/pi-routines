# Task: TP-008 — Cron, One-Off, Timezone, Multi-Trigger

**Created:** 2026-05-20
**Size:** L

## Review Level: 2 (Plan + Code)

**Assessment:** Foundational schema change. Touches the type at the heart of
the system (`Routine.trigger` becomes `Routine.triggers: RoutineTrigger[]`).
Migration path for existing state.json. Cron parser is non-trivial. Worth a
plan review before code lands, plus a code review of the migration.

**Score:** 5/8 — Blast radius: 2 (types + scheduler + store), Pattern novelty:
2 (cron parser + tz-aware Date math), Security: 0, Reversibility: 1 (state
migration is irreversible without a backup).

## Canonical Task Folder

```
taskplane-tasks/TP-008-cron-multi-trigger/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

1. Extend `RoutineTrigger` with three new pulse subkinds: `cron`, `oneoff`,
   and an optional `timezone` field on all pulse variants.
2. Allow each `Routine` to carry MULTIPLE triggers (`triggers: RoutineTrigger[]`).
3. Write a one-way migration from v1 state (`trigger: RoutineTrigger`) to v2
   state (`triggers: RoutineTrigger[]`). Wrap singletons into a single-element
   array. Back up the old file as `state.v1.json` before rewriting.
4. Teach the scheduler to arm all triggers on a routine and dedupe fires.

## Dependencies

None (foundational for TP-009/010/011).

## Context to Read First

**Tier 2:**

- `taskplane-tasks/CONTEXT.md`

**Tier 3:**

- `src/types.ts` — current `RoutineTrigger` shape
- `src/parser.ts` — for interval parsing reference style
- `src/store.ts` — for migration (atomic write + backup pattern)
- `src/scheduler.ts` — for current single-trigger arming
- `templates/*.json` — must still load (single-trigger form is the v1 shape)

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, ESM, TypeScript strict, biome
- **No new runtime deps** — write the cron parser by hand (5-field POSIX subset)

## File Scope

- `src/types.ts` (modify — additive)
- `src/parser.ts` (modify — add `parseCron`, `parseOneOff`)
- `src/store.ts` (modify — add `migrateV1ToV2` and call it in `loadStore`)
- `src/scheduler.ts` (modify — iterate over `routine.triggers`)
- `tests/parser.test.ts` (extend with cron + oneoff cases)
- `tests/store.test.ts` (extend with migration test)
- `tests/scheduler.test.ts` (NEW — multi-trigger arming smoke test)

## Steps

### Step 0: Preflight

- [ ] Branch is `task/lane-N`, base is `main`
- [ ] `pnpm check` passes on baseline
- [ ] Read current `RoutineTrigger` and `Routine` shapes — confirm v1 schema
      version (none — implicit v1)

### Step 1: Extend types (`src/types.ts`)

- [ ] Add `kind: "cron"` variant to pulse trigger union:
      `{ kind: "cron"; expr: string; timezone?: string }`
- [ ] Add `kind: "oneoff"` variant:
      `{ kind: "oneoff"; fireAtIso: string; timezone?: string }`
- [ ] Add optional `timezone?: string` (IANA, e.g. `"America/Los_Angeles"`) to
      the existing pulse `{ kind: "pulse" }` variant for cron-equivalent semantics
- [ ] Change `Routine.trigger: RoutineTrigger` → `Routine.triggers: RoutineTrigger[]`
- [ ] Add `schemaVersion: 2` field on `RoutineStore`
- [ ] Export `SCHEMA_VERSION = 2`
- [ ] JSDoc each new type
- [ ] `pnpm typecheck` passes (will FAIL until the rest of the codebase
      catches up — that's expected; mark this checkbox once types compile in
      isolation)

### Step 2: Cron + one-off parsers (`src/parser.ts`)

- [ ] Export `parseCron(expr: string): { minutes, hours, dom, month, dow }` —
      5-field POSIX subset. Support `*`, `*/n`, `a,b,c`, `a-b`. Reject seconds
      field, reject `?`/`L`/`#`.
- [ ] Export `nextCronFire(expr: string, tz: string | undefined, from: Date): Date`
- [ ] Export `parseOneOff(iso: string, tz?: string): Date` — accepts
      `"2026-06-01T09:00:00Z"` or `"2026-06-01T09:00:00"` (local in `tz` if set).
- [ ] Reject one-off in the past (>30s ago) with a clear error
- [ ] Reject cron expressions that match >1440 times/day (DOS guard)
- [ ] All existing parser tests still pass

### Step 3: Store migration (`src/store.ts`)

- [ ] On `loadStore`, if `schemaVersion` is missing or 1:
  - Read raw, wrap each routine's `trigger` field into `triggers: [trigger]`
  - Set `schemaVersion = 2`
  - Write `${STATE_FILE}.v1.bak` (copy of raw input) BEFORE overwriting
  - Log a single info line to stderr: `[pi-routines] migrated state.json to v2`
- [ ] Idempotent: re-running `loadStore` on a v2 file is a no-op
- [ ] Corrupt file path unchanged (still falls back to `emptyStore`)
- [ ] Add `tests/store.test.ts` cases for: v1→v2 migration, v2 no-op,
      missing-file no-op

### Step 4: Scheduler — multi-trigger arming (`src/scheduler.ts`)

- [ ] `scheduleRoutine(runtime, routine)` iterates over `routine.triggers`
      and arms one timer per trigger
- [ ] Store timer handles by `(routineId, triggerIndex)` — update
      `runtime.timers: Map<string, NodeJS.Timeout[]>`
- [ ] `unscheduleRoutine` clears all timers for the routine
- [ ] When ANY trigger fires, build the routine prompt and enqueue ONCE —
      the queue is keyed by routineId; concurrent fires from different
      triggers within 500ms collapse to one tick
- [ ] Cron timers re-arm themselves after each fire by computing `nextCronFire`
- [ ] One-off triggers unschedule themselves after firing (and the routine
      stays alive if it has other triggers; otherwise auto-delete iff
      `maxTicks === 1` or no other triggers)

### Step 5: Tests + DoD

- [ ] `tests/parser.test.ts` — 10+ cron cases (every minute, weekdays 9am,
      every 15m, etc.), 5+ oneoff cases (timezone math, past rejection)
- [ ] `tests/store.test.ts` — migration test using a tmp dir
- [ ] `tests/scheduler.test.ts` (NEW) — uses `node:test` mock timers
      (`MockTimers`) to verify a routine with two triggers fires twice but
      not concurrently
- [ ] `pnpm check` green (typecheck + lint + tests, ~60+ tests total)
- [ ] No new runtime deps (devDeps OK if needed — try not to)

## Definition of Done

- [ ] All steps' checkboxes green
- [ ] `pnpm check` exits 0 with ≥60 tests passing
- [ ] Existing v1 state.json files migrate automatically with a `.v1.bak`
- [ ] Templates (`templates/*.json`) still load (their schema is unchanged —
      the store wraps single triggers into arrays at install time)
- [ ] Commit message uses Conventional Commits: `feat(scheduler): cron, one-off,
    timezone, multi-trigger (TP-008)`
- [ ] `.DONE` and `STATUS.md` written per orch convention
