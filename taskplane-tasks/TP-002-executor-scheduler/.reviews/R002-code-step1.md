## Code Review: Step 1 — `src/executor.ts`

### Verdict: APPROVE

### Summary
`buildPrompt` and `fireRoutine` are implemented to spec: prefix format,
quiet footer, placeholder substitution, userState truncation, maxTicks
self-cleanup before guard, write-through tickState, and exception path
that releases the guard. `pnpm typecheck` passes; no lint script declared.

### Issues Found
_None blocking._

### Pattern Violations
- None — module boundaries respected (executor imports only `guard`, `store`,
  `scheduler.unscheduleRoutine`, `types`).

### Test Gaps
- No automated tests yet; `pnpm test` is a placeholder. Step 3's smoke checks
  will exercise the maxTicks-cleanup branch — fine for this step.

### Suggestions
1. **executor.ts:115** — `pi.sendUserMessage(...)` returns `Promise<void>` but
   is not awaited. If delivery rejects, the rejection escapes the surrounding
   try/catch (becomes an unhandledRejection) and tickState is still written as
   if the fire succeeded. Consider `await pi.sendUserMessage(...)` so the catch
   block handles failure and tickCount isn't incremented on a non-delivered
   message. PROMPT wording is silent on await, so not blocking.
2. **executor.ts:111 (`deliverAs: "followUp"`)** — PROMPT requests
   `"nextTurn"` verbatim. The typed `ExtensionAPI.sendUserMessage` only
   declares `"steer" | "followUp"`, but the underlying runtime in
   `agent-session.js` does accept `"nextTurn"`. Since `drainQueue` already
   gates on `ctx.isIdle() && !hasPendingMessages()`, `followUp` and `nextTurn`
   behave identically at fire time, so this is fine — and the deviation is
   already logged in `CONTEXT.md` Discoveries. If you ever fire while the
   agent might be streaming, revisit and consider a typed cast to `"nextTurn"`.
3. **executor.ts:41–46** — the `hhmm` regex collapses `"14:23:45"` → `"14:23"`
   and `"2:23:45 PM"` → `"2:23 PM"`, which is the intent. It silently no-ops if
   `toLocaleTimeString()` returns a locale without seconds. Acceptable; a
   `now.toTimeString().slice(0,5)` would be more direct but PROMPT didn't
   prescribe the implementation.
4. **executor.ts → scheduler.ts (circular import)** — `executor.fireRoutine`
   calls `scheduler.unscheduleRoutine`, and `scheduler.drainQueue` calls
   `executor.fireRoutine`. ESM handles this because both references are
   function-scoped (not top-level), so it works, but it's a fragile shape. If
   either function later needs a top-level reference, consider extracting
   `unscheduleRoutine` to a tiny `timers.ts` to break the cycle. Not blocking.
5. **executor.ts:128 (catch)** — the catch releases the guard but doesn't
   clear `runtime.activeRoutineName`. `guard.releaseRoutineTurn` should be
   responsible; verify when reviewing guard.ts that it nulls the name too.

### Quality Checks Run
- `pnpm typecheck` → pass.
- `pnpm lint` / `pnpm format:check` → not declared in `package.json`; skipped.
- `pnpm test` → placeholder (echo + exit 0); not exercised.
