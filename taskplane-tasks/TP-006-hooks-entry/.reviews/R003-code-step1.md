## Code Review: Step 1 — src/hooks.ts

### Verdict: APPROVE

### Summary
`src/hooks.ts` correctly implements the three lifecycle subscribers + input tracker per PLAN Phase 9. Recursion guard is snapshotted before release on `agent_end`, the at-most-one cap is hard-broken, shutdown hooks are gated on `reason === "quit"` AND `!isRoutineTurnActive`, and per-session daily/once semantics flow through `guard.shouldFireHook`. `pnpm typecheck` is clean; `pnpm test` is a placeholder echo per package.json. APIs used (`fireRoutine`, `scheduleRoutine`, `drainQueue`, `stopScheduler`, `loadStore`, `saveStore`, `guard.*`, widget helpers) match upstream signatures.

### Issues Found
None blocking.

### Pattern Violations
None — matches `pi-subagents` lifecycle shape and CONTEXT.md guarantees.

### Test Gaps
- No unit tests exist for hooks.ts (project has placeholder `test` script). Acceptable per project state; Step 4 in STATUS records the placeholder honestly.

### Suggestions
- `session_shutdown` only fires hooks when `event.reason === "quit"`. Per the SDK type (`"quit" | "reload" | "new" | "resume" | "fork"`), reasons `"new"`, `"resume"`, `"fork"` are also silently skipped. PROMPT only requires skipping `"reload"`. Behaviour is conservative/safe but worth a one-line comment noting that session-replacement reasons (new/resume/fork) also intentionally skip shutdown hooks since `session_start` of the new session will be the recovery point. (suggestion-level)
- `agent_end` calls `drainQueue` unconditionally; this is fine because `drainQueue` self-gates on idle/pending/guard, but a one-line comment that ctx may be print-mode and drainQueue tolerates it would aid future readers. (suggestion-level)
- `pickHookRoutines` snapshots into an array before iteration — good; if a hook ever mutates the store mid-loop (e.g. `RoutineCreate` from a shutdown hook), the snapshot prevents iterator surprise. The CONTEXT note documents the caveat. No change required.
