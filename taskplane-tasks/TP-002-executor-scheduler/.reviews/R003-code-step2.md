## Code Review: Step 2 — src/scheduler.ts

### Verdict: APPROVE

### Summary
Scheduler implements all required exports (`startScheduler`, `stopScheduler`,
`scheduleRoutine`, `unscheduleRoutine`, `drainQueue`) with correct dedup,
backpressure, and stale-ctx handling. `pnpm typecheck` passes; `pnpm test` is
a no-op script in this repo. File-header JSDoc clearly delineates ownership
(timers/queue) vs. non-ownership (`pi.on`, prompt building, hook-trigger
logic) as required by Step 5.

### Issues Found
None blocking.

### Pattern Violations
- None. Style (2-space indent, double quotes, semis, trailing commas) matches
  project standards.

### Test Gaps
- Step 3 integration smoke (timer round-trip + maxTicks short-circuit) was
  reportedly performed via a deleted `src/_smoke.ts`. Acceptable per PROMPT
  ("can be deleted before merge").

### Suggestions
- `scheduleRoutine` tick handler: after the dedup check (`queue.includes(id)`
  → skip), the subsequent backpressure branch `oldestIdx >= 0` is effectively
  unreachable — dedup guarantees this id is not in the queue at that point.
  The `else` branch (drop oldest queue entry) is the only one that fires.
  Defensible as defensive coding, but worth a 1-line comment, or simplify to
  just `runtime.queue.shift()` when at cap. (PLAN's "drop OLDEST entry for
  this routine" wording is itself slightly at odds with the dedup rule —
  consider noting the resolution in CONTEXT.md Discoveries.)
- `drainQueue` calls `runtime.lastUiCtx = ctx` before firing — this side
  effect on the runtime is undocumented in the JSDoc; a brief note would
  help future maintainers understand which subsystem consumes `lastUiCtx`.
- Cross-step note from Step 1 code: `executor.ts` uses `deliverAs:
  "followUp"` instead of the PROMPT-specified `"nextTurn"` because the
  typed `ExtensionAPI.sendUserMessage` signature only permits
  `"steer" | "followUp"`. Confirmed in
  `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`.
  The inline comment in `executor.ts` captures this — recommend logging the
  deviation in `CONTEXT.md` Discoveries / an Amendment so TP-006 and
  downstream tasks don't re-litigate it. (Not a Step 2 blocker.)
