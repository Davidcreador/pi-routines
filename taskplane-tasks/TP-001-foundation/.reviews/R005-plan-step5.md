## Plan Review: Step 5 — src/guard.ts

### Verdict: APPROVE

### Summary
Step 5 is a small set of pure helpers over `RoutineRuntimeState` plus a `shouldFireHook` predicate. PROMPT.md spec aligns with PLAN.md Phase 6 and the already-implemented `RoutineRuntimeState` fields in `src/types.ts` (`isRoutineTurnActive`, `activeRoutineName`). Scope is correctly bounded — no event subscriptions, those belong to TP-006 hooks.

### Issues Found
None blocking.

### Suggestions
- `acquireRoutineTurn` throw-if-active: include both the incoming and currently-active routine names in the error so future hook-layer bugs are diagnosable.
- `releaseRoutineTurn`: make it idempotent (no-op if already inactive) so the executor catch-block in PLAN.md (which also resets on exception) doesn't risk a double-release throwing.
- `shouldFireHook`: guard for non-hook triggers (return true) so callers don't need to pre-filter; matches PLAN.md `shouldFireHook` signature taking a `Routine`.
- For `per_session`: PLAN.md notes session_start resets guard; per-session tracking likely needs a runtime-scoped "fired this session" set (not `tickState` which persists). Either add a `firedThisSession: Set<string>` field to `RoutineRuntimeState` (amendment) or document that per_session is implemented by callers checking runtime state and document the contract here. Worth resolving before TP-006 consumes it — but acceptable to defer to an amendment if discovered during impl.
- Use `Intl.DateTimeFormat` or `toLocaleDateString("en-CA")` consistently with `RoutineTickState.lastFiredDateLocal` writers in executor (TP-002) — call out the format string in JSDoc to lock the contract.
