## Plan Review: Step 1 — src/hooks.ts

### Verdict: APPROVE

### Summary
Step 1 plan in PROMPT.md is well-scoped and outcome-level: it enumerates the three lifecycle handlers plus the input tracker, calls out the recursion-guard sequencing (capture-before-release in `agent_end`, drainQueue always, at-most-one hook), the reload-vs-quit branching for `session_shutdown`, and the per_session/reload skip in `session_start`. The guard primitives it depends on (`acquireRoutineTurn`, `releaseRoutineTurn`, `isRoutineTurnActive`, `shouldFireHook`) already exist in `src/guard.ts`, and scheduler/executor/store/widget exports are in place.

### Issues Found
*None blocking.*

### Suggestions
- The `agent_end` "at most one hook" rule should be deterministic — suggest documenting iteration order (insertion order from `runtime.store.routines`) in the JSDoc so reviewers and users can predict which hook wins on collision.
- `session_shutdown` plan says "fire all shutdown hooks sequentially" but does not specify whether to wrap each in try/catch so one failing hook doesn't abort `saveStore` + `clearWidget`. Worth handling — a thrown hook on shutdown shouldn't lose the store write. Not blocking; flag for code review.
- The input tracker bullet says to return `{ action: "continue" }` or `undefined`; confirm against `ExtensionAPI` typing during implementation — pi-subagents reference shows the exact shape.
- Consider also resetting `runtime.activeRoutineName = null` in `session_shutdown` for symmetry with `session_start` (cheap, prevents stale state if the runtime object is somehow reused).

### Missing Items
- None at outcome level. Per-handler responsibilities, ordering, and guard interactions are all enumerated.
