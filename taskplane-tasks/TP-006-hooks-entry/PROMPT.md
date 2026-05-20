# Task: TP-006 — Lifecycle Hooks & Extension Entry Point

**Created:** 2026-05-19
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** Final integration task. Wires every prior module into a single
extension export. Owns the recursion-critical lifecycle subscribers
(`session_start`, `agent_end`, `session_shutdown`) and the hot-reload safety
contract. Code review needed: this is where leaks, double-registrations, and
loop bugs surface.

**Score:** 4/8 — Blast radius: 2 (a bug here breaks every routine across every session), Pattern novelty: 1 (proven from pi-subagents and pi-working-vibe), Security: 0, Reversibility: 1 (need a restart to fix)

## Canonical Task Folder

```
taskplane-tasks/TP-006-hooks-entry/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Subscribe to `session_start`, `agent_end`, and `session_shutdown` to drive the
routine lifecycle, plus wire all the prior modules (tools, commands, suppressor,
widget, scheduler) into a single `extensions/index.ts` that exports the default
register function. Includes hot-reload cleanup using the same global-store
pattern as `pi-subagents`.

## Dependencies

- **Task:** TP-001 (foundation)
- **Task:** TP-002 (scheduler + executor)
- **Task:** TP-003 (suppressor + widget)
- **Task:** TP-005 (tools register functions)
- **Task:** TP-007 (command register functions + `_mutate.ts`)

## Context to Read First

**Tier 2:**
- `taskplane-tasks/CONTEXT.md`

**Tier 3:**
- `PLAN.md` — Phase 9 (Hooks) and Phase 13 (Extension Entry Point), plus the
  Edge Case Matrix items 1, 5, 6, 8, 9
- `src/guard.ts` (TP-001) — recursion-guard primitives
- `src/scheduler.ts` (TP-002) — `startScheduler` / `stopScheduler` / `drainQueue`
- `src/executor.ts` (TP-002) — `fireRoutine`
- Reference implementation: read `/Users/davecodes/work/ai-tutor-core/.pi/npm/node_modules/pi-subagents/src/extension/index.ts`
  for the hot-reload + global-store pattern. Reuse the same shape.

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, ESM, TypeScript strict

## File Scope

- `src/hooks.ts` (new)
- `extensions/index.ts` (new)

## Steps

### Step 0: Preflight

- [ ] TP-001, TP-002, TP-003, TP-005, TP-007 are all complete
- [ ] All register functions exist and compile
- [ ] `pi-subagents/src/extension/index.ts` is readable for reference

### Step 1: `src/hooks.ts`

Implement exactly as specified in `PLAN.md` Phase 9.

- [ ] Export `registerHooks(pi, runtime, getCtx, setCtx): void`
- [ ] Export `registerInputTracker(pi, runtime): void` — the `input` event
  handler that tags routine-sourced inputs (see PLAN.md Phase 6, Level 2)

**`session_start` handler:**
- [ ] Reset `runtime.isRoutineTurnActive = false`, `runtime.activeRoutineName = null`
- [ ] `runtime.store = await loadStore()`
- [ ] For each pulse routine in `runtime.store.routines`: `scheduleRoutine(...)`
- [ ] For each hook routine matching `session_start`:
  - If `event.reason === "reload"`: skip hooks with `once: "per_session"`
  - Else: call `shouldFireHook` (from guard.ts); fire via `fireRoutine` if allowed
- [ ] Save context: `setCtx(ctx)`; call `updateWidget(runtime, ctx)`

**`agent_end` handler:**
- [ ] Capture `wasRoutineTurn = isRoutineTurnActive(runtime)` BEFORE releasing
- [ ] If `wasRoutineTurn`: `releaseRoutineTurn(runtime)`
- [ ] Always call `drainQueue(runtime, pi, getCtx)`
- [ ] If NOT a routine turn: iterate `agent_end` hooks, fire AT MOST ONE
  (after firing, break)
- [ ] `updateWidget`

**`session_shutdown` handler:**
- [ ] `stopScheduler(runtime)`; clear queue
- [ ] If `event.reason === "quit"` AND not currently a routine turn: fire all
  `session_shutdown` hooks (sequentially; await each)
- [ ] On `reason: "reload"`: do NOT fire shutdown hooks
- [ ] `await saveStore(runtime.store)`
- [ ] `clearWidget(ctx)`
- [ ] Reset `isRoutineTurnActive = false`

**`input` tracker (for recursion guard, Level 2):**
- [ ] Subscribe to `pi.on("input", (event, ctx) => ...)`
- [ ] If `event.source === "extension"` AND `runtime.isRoutineTurnActive`:
  no-op (the guard flag itself is enough — the input tracker exists as a
  belt-and-suspenders log so reviewers can see the path). Add a debug
  `console.error("[routines] extension input under active routine guard")` so
  the path is observable.
- [ ] Do NOT call `event` mutation; return `{ action: "continue" }` or
  `undefined` so the input continues normally.

**Artifacts:**
- `src/hooks.ts` (new)

### Step 2: `extensions/index.ts`

Implement exactly as specified in `PLAN.md` Phase 13.

- [ ] Export default `registerRoutinesExtension(pi: ExtensionAPI): void`
- [ ] Hot-reload cleanup using `globalThis` store key `__piRoutinesCleanup` —
  mirror the pi-subagents pattern
- [ ] Create `runtime: RoutineRuntimeState` (single instance per load)
- [ ] Maintain `let currentCtx: ExtensionContext | null = null`; pass
  `() => currentCtx` as `getCtx` to scheduler + hooks; update it in
  `session_start` / `agent_end` / `tool_result` handlers (set
  `runtime.lastUiCtx = ctx` in the same place)
- [ ] Register order:
  1. Tools (TP-005) — `registerRoutineCreateTool`, ...List, ...Delete, ...SetState
  2. Slash commands (TP-007) — all six
  3. Suppressor (TP-003) — `registerSuppressor`
  4. Hooks (this task) — `registerHooks`, `registerInputTracker`
- [ ] Cleanup function stored on `globalThis[CLEANUP_KEY]`:
  - `stopScheduler(runtime)`
  - `stopWidgetRefresh()` (whatever handle `startWidgetRefresh` returned)
  - `clearWidget(ctx)` if UI available
- [ ] Print-mode short-circuit: if running in `--print` mode (detect via
  `ctx.hasUI === false` at `session_start`), still register tools (LLM may
  call them) but do NOT start timers and do NOT update the widget. The
  `session_start` handler should branch on `ctx.hasUI`.

**Artifacts:**
- `extensions/index.ts` (new)

### Step 3: Edge case verification (manual trace, no test framework yet)

Walk through each edge case in `PLAN.md` Edge Case Matrix and confirm the
code handles it. Document any that surface a bug in `Amendments` of this PROMPT.md.

- [ ] **Hot reload (`/reload`)**: `session_shutdown(reason: "reload")` →
  cleanup runs, timers cleared, store saved. New extension instance:
  `session_start(reason: "reload")` re-initializes from disk.
- [ ] **Routine fires mid-LLM stream**: scheduler tick → not idle → queued.
  `agent_end` → `drainQueue` → fires.
- [ ] **Multiple sessions**: in-memory routines are session-local. Persistent
  store has last-write-wins via atomic rename. Document this caveat in
  CONTEXT.md.
- [ ] **`maxTicks: 1` one-shot**: executor checks `tickCount >= maxTicks`
  BEFORE firing and deletes the routine. ✅ via TP-002.
- [ ] **`deploy-watch` self-deletion**: LLM calls `RoutineDelete` during its
  routine turn. Tool runs normally; routine is removed; guard prevents
  agent_end from firing another routine. ✅
- [ ] **Shutdown with pending queue**: queue cleared first, then hooks fire.
  Hooks-injected items would re-queue, but they fire as the last action
  before the timer is gone. Document that `session_shutdown` hooks should
  NOT use `RoutineCreate` (no point).
- [ ] **Once-daily timezone shift**: `lastFiredDateLocal` changes when TZ
  changes → routine fires again. Acceptable.
- [ ] **Corrupt state file**: `loadStore` returns empty. `.bak` is offered
  for manual recovery. Log a warning visible in stderr.
- [ ] **Print mode**: tools registered, timers/widget skipped. ✅

### Step 4: Testing & Verification

> ZERO failures.

- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm test` exits 0
- [ ] Manual install smoke test (best-effort, document in STATUS.md Notes):
  1. From the `pi-routines/` repo root: add the package path to
     `~/.pi/agent/settings.json` `extensions` array (back up first)
  2. Start pi in a scratch directory
  3. `/routine 30s say hi` — expect: routine created, fires in 30s
  4. `/routines` — expect: one routine listed
  5. `/routine-stop say-hi` (auto-name) — expect: removed
  6. `/routine-install pomodoro` — expect: installed, fires at 25m
  7. Restart pi — expect: durable routines still there (note: only the store
     persists; pulse timers restart fresh)
  8. Restore settings.json from backup
  9. Outcome (pass/fail per step) recorded in STATUS.md
- [ ] If smoke test reveals bugs: file Amendments and fix before claiming done

### Step 5: Documentation & Delivery

- [ ] README.md at repo root with: install instructions, 30-second tour
  (install ci-watch and morning-briefing), config file location, link to
  PLAN.md for architecture
- [ ] File-header JSDoc on `hooks.ts` and `extensions/index.ts`
- [ ] CONTEXT.md Discoveries updated with all surprises from edge-case walk
- [ ] Tag this work as `v0.1.0` candidate (do not actually publish to npm)

## Documentation Requirements

**Must Update:**
- `README.md` at repo root (new file)
- `taskplane-tasks/CONTEXT.md` — Discoveries

**Check If Affected:**
- `PLAN.md` — do not modify; log Amendments here

## Completion Criteria

- [ ] All steps complete
- [ ] `pnpm typecheck` zero errors
- [ ] Manual smoke test recorded in STATUS.md Notes
- [ ] `README.md` exists

## Git Commit Convention

- **Step completion:** `feat(TP-006): complete Step N — description`
- **Bug fixes:** `fix(TP-006): description`
- **Hydration:** `hydrate: TP-006 expand Step N checkboxes`

## Do NOT

- Subscribe to `before_agent_start` — not in v1's scope
- Subscribe to `message_end` here — that's owned by the suppressor (TP-003)
- Fire multiple `agent_end` hooks per turn — strict one-per-turn limit
- Skip the recursion guard checks in any of the lifecycle handlers
- Skip the hot-reload `globalThis` cleanup pattern (mandatory for `/reload`
  to work without leaking timers)
- Publish to npm — that comes after a separate review pass

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues are discovered during execution. -->
