# pi-routines — Task Area Context

**Next Task ID:** 8

## Current State

This area owns the complete pi-routines extension implementation. The extension
gives Pi sessions the ability to run recurring prompts (pulse routines) and
event-driven hooks. See `PLAN.md` at the repo root for the full design.

### Module ownership (target layout)

```
pi-routines/
├── package.json                    # TP-001
├── tsconfig.json                   # TP-001
├── PLAN.md                         # Reference (immutable for these tasks)
├── extensions/
│   └── index.ts                    # TP-006 (entry point + wiring)
├── src/
│   ├── types.ts                    # TP-001
│   ├── store.ts                    # TP-001
│   ├── parser.ts                   # TP-001
│   ├── guard.ts                    # TP-001
│   ├── executor.ts                 # TP-002
│   ├── scheduler.ts                # TP-002
│   ├── suppressor.ts               # TP-003
│   ├── widget.ts                   # TP-003
│   ├── hooks.ts                    # TP-006
│   ├── tools/                      # TP-005
│   │   ├── routine-create.ts
│   │   ├── routine-list.ts
│   │   ├── routine-delete.ts
│   │   └── routine-set-state.ts
│   └── commands/                   # TP-007
│       ├── routine.ts
│       ├── routine-on.ts
│       ├── routines.ts
│       ├── routine-stop.ts
│       ├── routine-install.ts
│       └── routine-export-cron.ts
├── skills/routine/SKILL.md         # TP-004
└── templates/*.json (7 files)      # TP-004
```

### Build / test commands

- **Typecheck:** `pnpm typecheck` (runs `tsc --noEmit`)
- **Tests:** `pnpm test` (initially no tests; workers add unit tests where useful)
- **Install deps:** `pnpm install`

### Dependencies (npm)

- `@earendil-works/pi-coding-agent` (peer) — extension API
- `@earendil-works/pi-tui` (peer) — TUI primitives
- `typebox` (dep) — tool schema validation
- `nanoid` (dep) — routine IDs

## Wave Layout

```
Wave 1: TP-001 (foundation)
Wave 2: TP-002, TP-003, TP-004 (parallel — non-overlapping files)
Wave 3: TP-005 (tools)
Wave 4: TP-007 (slash commands)
Wave 5: TP-006 (hooks + entry point wiring)
```

## Architectural Invariants (do not violate)

1. **All shared shapes live in `src/types.ts`.** Other modules import from there.
2. **`store.ts` is the only writer of `state.json`.** Atomic writes via tmp+rename.
3. **Recursion guard is checked in every event hook handler.** No exceptions.
4. **`pi.sendUserMessage()` is the only way routine prompts enter the session.**
   Use `{ deliverAs: "nextTurn" }` to avoid interrupting in-flight turns.
5. **In `--print` (headless) mode the extension is a no-op for side effects.**
   Tools still register; timers/widgets/hooks do nothing.
6. **Hot reload safety:** every module that holds resources (timers, intervals,
   listeners) MUST clean up on `session_shutdown` and tolerate being loaded twice.

## Discoveries Log

| Discovery                                                                                                                                                                                                                                                                                                                                | Disposition        | Location                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------- |
| `pi.sendUserMessage` exists with `deliverAs: "steer" \| "followUp"`                                                                                                                                                                                                                                                                      | Used by executor   | extensions/index.ts                 |
| `message_end` event allows full message replacement via return value                                                                                                                                                                                                                                                                     | Used by suppressor | suppressor.ts                       |
| `InputEvent.source === "extension"` identifies extension-injected input                                                                                                                                                                                                                                                                  | Used by guard      | guard.ts                            |
| `ctx.ui.setStatus(key, text)` adds non-intrusive footer entries                                                                                                                                                                                                                                                                          | Used by widget     | widget.ts                           |
| TP-001 foundation done — no deviations from PLAN.md Phases 1–4/6                                                                                                                                                                                                                                                                         | n/a                | src/{types,parser,store,guard}.ts   |
| `STATE_FILE` resolved at module load using `process.env.HOME` with `/tmp` fallback (kept the literal constant rather than a getter, matching PLAN snippet)                                                                                                                                                                               | TP-001             | src/types.ts                        |
| Parser uses `String.matchAll` segment scan; rejects residuals to catch garbage like `"5m banana"`                                                                                                                                                                                                                                        | TP-001             | src/parser.ts                       |
| PLAN/PROMPT direct `deliverAs: "nextTurn"` on `pi.sendUserMessage`, but typed API only exposes `"steer" \| "followUp"`. Used `"followUp"` (non-interrupting queue-after-current-turn).                                                                                                                                                   | TP-002             | src/executor.ts `fireRoutine`       |
| scheduler↔executor have a mutual import (`fireRoutine` / `unscheduleRoutine`). Safe because both bindings are used only inside function bodies, never at module init time. Verified with smoke harness + ESM runtime.                                                                                                                    | TP-002             | src/{scheduler,executor}.ts         |
| Built-in templates shipped: `ci-watch`, `morning-briefing`, `pomodoro`, `deploy-watch`, `session-wrap`, `pr-babysitter`, `test-guardian`. `ci-watch` and `pr-babysitter` declare `requiredTools: ["gh"]` (warning only)                                                                                                                  | TP-004             | templates/\*.json                   |
| Routine management skill authored covering tool-vs-command surface, pulse vs hook, quiet semantics, self-termination, pitfalls                                                                                                                                                                                                           | TP-004             | skills/routine/SKILL.md             |
| Extracted `resolveRoutine(store, id?, name?)` + `listRoutineNames(store)` helper for id-then-name (case-insensitive) lookup; reused by RoutineDelete and RoutineSetState                                                                                                                                                                 | TP-005             | src/tools/\_resolve.ts              |
| `RoutineCreate` is upsert-by-name (existing name updates in place, preserves id/createdAt/tickState); re-schedules pulse only if interval/kind changed                                                                                                                                                                                   | TP-005             | src/tools/routine-create.ts         |
| Tool `renderCall`/`renderResult` use `new Text(string, 0, 0)` from `@earendil-works/pi-tui`, matching the structured-output example                                                                                                                                                                                                      | TP-005             | src/tools/\*                        |
| Extracted `_mutate.ts` (createRoutine/deleteRoutine/resolveRoutine) as the single source of routine mutation truth; tools and slash commands both delegate to it. `routine-create.ts` and `routine-delete.ts` are now thin schema-validation wrappers. `_resolve.ts` retained for `RoutineSetState` which takes separate id/name params. | TP-007             | src/tools/\_mutate.ts               |
| `/routine <interval> <prompt>` parses the interval greedily left-to-right (joining tokens until `parseInterval` succeeds), so multi-word forms like `1h 30m`, `2 hours`, `every 5m` all work. Auto-name = first 3 prompt words kebab-cased, capped at 32 chars, collision-suffixed `-2`, `-3`, …                                         | TP-007             | src/commands/routine.ts             |
| `/routine-on` aliases: start→session_start, end→agent_end, stop/shutdown→session_shutdown. `agent_end` uniqueness is enforced by `_mutate.createRoutine`.                                                                                                                                                                                | TP-007             | src/commands/routine-on.ts          |
| `/routine-export-cron` writes prompt+plist to `~/.pi/routines/{prompts,launchd}/` and PRINTS the crontab line — it never modifies the user's crontab or loads launchd jobs. Refuses hook routines (no time component) and pulses > 60m (use a daily cron manually). JSDoc block has to split `"*" + "/N"` to avoid closing the comment.  | TP-007             | src/commands/routine-export-cron.ts |
| Slash commands post system feedback via `pi.sendMessage({ customType: "pi-routines/system", content, display: true })`. No custom renderer registered yet — falls through to default string rendering.                                                                                                                                   | TP-007             | src/commands/\*                     |
| `pi.exec` returns `{ code: number, ... }`, NOT `exitCode` — see `node_modules/@earendil-works/pi-coding-agent/dist/core/exec.d.ts`.                                                                                                                                                                                                      | TP-007             | src/commands/routine-install.ts     |
