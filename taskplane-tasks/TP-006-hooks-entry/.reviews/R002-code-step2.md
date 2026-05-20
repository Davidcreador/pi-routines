## Code Review: Step 2 — extensions/index.ts (and src/hooks.ts wiring)

### Verdict: APPROVE

### Summary
Entry point cleanly wires runtime singleton, hot-reload cleanup via `globalThis.__piRoutinesCleanup`, fixed registration order (tools → commands → suppressor → hooks/input), and live `ctx` propagation on `session_start` / `agent_end` / `tool_result`. `pnpm typecheck` passes; no lint/format scripts declared. Hooks module enforces the recursion-guard contract correctly (snapshot before release, drainQueue always, at-most-one `agent_end` hook only on user turns, shutdown hooks gated on `reason === "quit"` AND no in-flight routine turn).

### Issues Found

1. **[src/widget.ts:61 / extensions/index.ts:97]** important — `startWidgetRefresh` is invoked at extension register time, BEFORE `session_start` has loaded the store. At that moment `runtime.store = emptyStore()`, so the `hasPulse` guard inside `startWidgetRefresh` returns `false` and the returned stop is a no-op — **the periodic refresh interval is never actually armed**, even after pulse routines load. Lifecycle-driven `updateWidget` calls (on session_start / agent_end) still keep the widget accurate at event boundaries, so this is not user-visible breakage, but the countdown ticker the function is intended to provide is dead. Fix: call `startWidgetRefresh` from inside the `session_start` handler (after `runtime.store = await loadStore()` and the `!ctx.hasUI` short-circuit) and store the stop fn somewhere the cleanup function can see, OR change `startWidgetRefresh` to check `hasPulse` inside the interval tick rather than at start time.

### Pattern Violations
- None. Mirrors `pi-subagents` global-cleanup pattern as instructed.

### Test Gaps
- No unit/integration tests; project's `test` script is a placeholder per `package.json`. Acceptable per task scope but worth noting that the recursion-guard contract (the riskiest path) is verified only by manual trace in STATUS Step 3.

### Suggestions
- Consider resetting `runtime.activeRoutineName = null` alongside `releaseRoutineTurn` in `agent_end` for log clarity (the guard module may already do this — worth verifying).
- The `tool_result` handler updates `currentCtx` unconditionally. Harmless, but `ctx` from `tool_result` and from `agent_end` should be the same object instance in practice; the redundancy is fine as belt-and-suspenders.
- `session_shutdown` calls `stopScheduler` (which clears the queue), then conditionally fires shutdown hooks. If a shutdown hook synchronously calls `RoutineCreate`, the new routine's timer will not be armed (scheduler stopped) — the STATUS note + JSDoc already document this; consider also having the `RoutineCreate` tool no-op-with-warning when invoked from within a `session_shutdown` hook turn (out of scope here, file as a follow-up).
- Minor: the `try/catch` blocks in the cleanup function swallow errors silently. A single `console.error("[pi-routines] cleanup error:", err)` would help debug `/reload` issues without changing behaviour.
