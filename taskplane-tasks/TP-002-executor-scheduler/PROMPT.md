# Task: TP-002 — Executor & Scheduler core

**Created:** 2026-05-19
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** This is the heart of pi-routines. Scheduler manages timers,
queue draining, and idle detection; executor builds prompts and invokes
`pi.sendUserMessage`. Recursion-critical and timing-sensitive. Code review
needed to catch race conditions and timer leak vectors.

**Score:** 4/8 — Blast radius: 2 (every routine fires through here, bugs cascade), Pattern novelty: 1 (timer + queue is standard, but injection contract is novel), Security: 0, Reversibility: 1 (timer state isn't persisted; a bad release means restart only)

## Canonical Task Folder

```
taskplane-tasks/TP-002-executor-scheduler/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Implement the engine that fires routines: build the prompt with state injection,
inject it via `pi.sendUserMessage`, manage `setInterval` timers for pulse
routines, queue when busy, drain when idle. This module is the runtime behavior
of every routine.

## Dependencies

- **Task:** TP-001 (types, store, parser, guard must exist)

## Context to Read First

**Tier 2 (area context):**
- `taskplane-tasks/CONTEXT.md`

**Tier 3 (load only as needed):**
- `PLAN.md` — Phases 4 (Scheduler), 5 (Executor), 6 (Guard for how to integrate)
- `src/types.ts` (from TP-001) — for all shared shapes
- `src/store.ts`, `src/guard.ts`, `src/parser.ts` (from TP-001) — for the helpers
  these modules call

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Services required:** None
- **Runtime:** Node 22+, ESM, TypeScript strict mode

## File Scope

- `src/executor.ts` (new)
- `src/scheduler.ts` (new)

## Steps

### Step 0: Preflight

- [ ] TP-001 is complete (`.DONE` exists in `taskplane-tasks/TP-001-foundation/`)
- [ ] `src/types.ts`, `src/store.ts`, `src/guard.ts`, `src/parser.ts` all exist
- [ ] `pnpm typecheck` passes against the existing TP-001 modules

### Step 1: `src/executor.ts` — prompt building + firing

Implement exactly as specified in `PLAN.md` Phase 5.

- [ ] Export `buildPrompt(routine, tickState, cwd): string`
- [ ] Export `fireRoutine(routine, runtime, store, pi, ctx): Promise<void>`
- [ ] Prompt prefix format (verbatim):
  ```
  [↺ routine: <name> · tick <n> · <HH:MM>]
  Previous state: <JSON of userState>

  <user prompt text>
  ```
- [ ] When `routine.quiet === true`, append after the prompt:
  ```
  ---
  If nothing changed and there is nothing to report, respond with exactly: [~]
  Do not explain that you are responding with [~]. Just output [~] and nothing else.
  ```
- [ ] Substitute placeholders in `routine.prompt`: `{cwd}` → `ctx.cwd`,
  `{date}` → `new Date().toLocaleDateString()`, `{time}` →
  `new Date().toLocaleTimeString()`, `{state}` → JSON of `tickState.userState`,
  `{tickCount}` → `String(tickState.tickCount + 1)`.
- [ ] If `JSON.stringify(userState).length > MAX_USER_STATE_BYTES`, replace
  with `{}` and append `[state truncated]` note in prompt.
- [ ] Before firing: check `maxTicks` — if `tickCount >= maxTicks`, call
  `unscheduleRoutine` + remove from store + save, then return WITHOUT firing.
- [ ] Acquire recursion guard via `guard.acquireRoutineTurn(runtime, routine.name)`
- [ ] Call `pi.sendUserMessage(prompt, { deliverAs: "nextTurn" })`
- [ ] Update `tickState`: increment `tickCount`, set `lastFiredAt = Date.now()`,
  set `lastFiredDateLocal = new Date().toLocaleDateString("en-CA")`. Preserve
  existing `userState`.
- [ ] Save store immediately after tickState update (write-through).
- [ ] Wrap the entire body in try/catch. On exception: release the guard
  (`guard.releaseRoutineTurn`), log the error, do not re-throw. Routine survives.
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/executor.ts` (new)

### Step 2: `src/scheduler.ts` — timer + queue management

Implement exactly as specified in `PLAN.md` Phase 4.

- [ ] Export `startScheduler(runtime, pi, getCtx)`: starts intervals for every
  pulse routine in `runtime.store.routines`
- [ ] Export `stopScheduler(runtime)`: `clearInterval` on every timer, clear
  the queue, leave `runtime.store` intact (caller saves it)
- [ ] Export `scheduleRoutine(routine, runtime, pi, getCtx)`: starts the
  `setInterval` for a single pulse routine. Idempotent (clears any existing
  timer for the same id first).
- [ ] Export `unscheduleRoutine(routineId, runtime)`: clears one timer
- [ ] Export `drainQueue(runtime, pi, getCtx)`: while queue is non-empty AND
  ctx is idle AND `!hasPendingMessages` AND `!isRoutineTurnActive`, shift
  next id and call `fireRoutine`. Stops at the first not-idle check.
- [ ] On every tick:
  1. If routine no longer exists in store: clear its timer, continue.
  2. If `runtime.queue` includes this id already: skip (dedup).
  3. If `runtime.queue.length >= MAX_QUEUE_DEPTH`: drop the OLDEST entry for
     this routine (`.findIndex` + `.splice`) before pushing.
  4. Push id to queue.
  5. Call `drainQueue`.
- [ ] Catch "Extension context no longer active" errors from `getCtx()`: stop
  that timer permanently and remove from `runtime.timers`.
- [ ] `pnpm typecheck` passes

**Artifacts:**
- `src/scheduler.ts` (new)

### Step 3: Integration sanity check

The pieces must compose. Write a small inline check (guarded by
`import.meta.main`) OR a one-off test file that does NOT run as part of the
real test suite. Verify:

- [ ] Importing both `executor.ts` and `scheduler.ts` together does not
  produce circular-dependency warnings or type errors
- [ ] `scheduleRoutine` followed immediately by `unscheduleRoutine` leaves
  `runtime.timers.size === 0`
- [ ] Calling `fireRoutine` with a routine whose `maxTicks === tickCount`
  removes the routine from the store and returns without firing
- [ ] These checks can be deleted before merge; they are confidence smoke
  tests, not durable tests

### Step 4: Testing & Verification

> ZERO test failures allowed.

- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm test` exits 0
- [ ] No new circular imports introduced

### Step 5: Documentation & Delivery

- [ ] File-header JSDoc on both modules covering: what they own, what they DON'T
  own (e.g., scheduler does NOT subscribe to lifecycle events — hooks.ts does)
- [ ] Discoveries logged in `taskplane-tasks/CONTEXT.md`

## Documentation Requirements

**Must Update:**
- `taskplane-tasks/CONTEXT.md` — Discoveries table

**Check If Affected:**
- `PLAN.md` — do not modify; log deviations via Amendment

## Completion Criteria

- [ ] All steps complete
- [ ] `pnpm typecheck` zero errors
- [ ] Both source files exist with the exported APIs listed above

## Git Commit Convention

- **Step completion:** `feat(TP-002): complete Step N — description`
- **Bug fixes:** `fix(TP-002): description`
- **Hydration:** `hydrate: TP-002 expand Step N checkboxes`

## Do NOT

- Subscribe to any `pi.on(...)` events here — those subscriptions belong in
  `hooks.ts` (TP-006). Scheduler only exposes functions that hooks.ts calls.
- Touch `src/types.ts` (owned by TP-001) — if a shape is missing, file an
  Amendment to TP-001 and use a local interface in the meantime
- Implement suppression (that's TP-003) or widget updates (TP-003) here
- Use `setTimeout` instead of `setInterval` for periodic ticks
- Catch errors silently — every catch must `console.error` with enough context

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues are discovered during execution. -->
