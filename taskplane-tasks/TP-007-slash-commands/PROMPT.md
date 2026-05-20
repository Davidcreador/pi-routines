# Task: TP-007 — Slash Commands

**Created:** 2026-05-19
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Six slash command handlers. They delegate to the same store
mutation + scheduler logic the tools use, with parsing on top. Plan review
confirms parsing rules and argument-completion behavior.

**Score:** 2/8 — Blast radius: 1 (user-facing surface), Pattern novelty: 1
(shorthand parsers around existing tool logic), Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-007-slash-commands/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Implement the six slash commands documented in `PLAN.md` Phase 11:
`/routine`, `/routine-on`, `/routines`, `/routine-stop`, `/routine-install`,
`/routine-export-cron`. Each command is a thin parser on top of the same
core mutation logic the tools (TP-005) use.

## Dependencies

- **Task:** TP-001 (parser, store)
- **Task:** TP-002 (scheduler)
- **Task:** TP-004 (templates dir must exist for `/routine-install`)
- **Task:** TP-005 (commands SHOULD share a mutation helper with tools — see
  Step 1 below)

## Context to Read First

**Tier 2:**
- `taskplane-tasks/CONTEXT.md`

**Tier 3:**
- `PLAN.md` — Phase 11 (Slash Commands)
- `src/tools/routine-create.ts` (TP-005) — the core create mutation that
  `/routine` and `/routine-on` and `/routine-install` should call
- `src/tools/routine-delete.ts` (TP-005) — for `/routine-stop`

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, ESM, TypeScript strict

## File Scope

- `src/commands/routine.ts` (new)
- `src/commands/routine-on.ts` (new)
- `src/commands/routines.ts` (new)
- `src/commands/routine-stop.ts` (new)
- `src/commands/routine-install.ts` (new)
- `src/commands/routine-export-cron.ts` (new)
- `src/tools/_mutate.ts` (new) — see Step 1

## Steps

### Step 0: Preflight

- [ ] TP-001, TP-002, TP-004, TP-005 are all complete
- [ ] `templates/` directory exists with 7 JSON files

### Step 1: Extract shared mutation helper `src/tools/_mutate.ts`

The tools in TP-005 and the commands here MUST not duplicate create/delete
logic. Refactor by extraction:

- [ ] Create `src/tools/_mutate.ts` exporting pure functions:
  - `createRoutine(input, runtime, pi, getCtx): Promise<{ id, name, triggerDescription, nextFireIn? } | { error }>`
  - `deleteRoutine(idOrName, runtime): Promise<{ deletedId, deletedName } | { error }>`
  - `resolveRoutine(idOrName, runtime): Routine | undefined` (used in multiple places)
- [ ] Refactor `routine-create.ts` and `routine-delete.ts` (from TP-005) to
  delegate to these helpers. The Tool's `execute` becomes a thin schema-validation
  wrapper. Make this a single commit: `refactor(TP-007): extract _mutate.ts helpers`
- [ ] All tools still pass `pnpm typecheck`

> **Note for the worker:** if TP-005's files are still pristine, do the
> extraction in one go. If TP-005's reviewer flagged duplication, this step
> resolves that. Either way, both tools and commands call the same helpers.

**Artifacts:**
- `src/tools/_mutate.ts` (new)
- `src/tools/routine-create.ts` (modified — delegate to _mutate)
- `src/tools/routine-delete.ts` (modified — delegate to _mutate)

### Step 2: `src/commands/routine.ts` — `/routine <interval> <prompt>`

- [ ] Export `registerRoutineCommand(pi, runtime, getCtx): void` via `pi.registerCommand`
- [ ] Parsing strategy:
  1. Strip leading `/routine ` (the command name is already routed away)
  2. Pull tokens left-to-right; concatenate until `parseInterval(joined)`
     succeeds. The remaining tokens are the prompt. If no leading token-set
     parses as an interval: return error with examples.
  3. Generate name from first 3 prompt words (lowercased, kebab-cased, max 32
     chars). On collision: append `-2`, `-3`, ...
- [ ] Call `createRoutine` with `{ kind: "pulse", interval, prompt, name, quiet: false }`
- [ ] On success: post a system message confirming creation and the auto-name
  (use `pi.sendMessage({ customType: ..., content: ... })` not `sendUserMessage`)
- [ ] On error: post error message with the parsing rules and an example

### Step 3: `src/commands/routine-on.ts` — `/routine-on <event> <prompt>`

- [ ] First token after `/routine-on ` is the event. Accept aliases:
  `start → session_start`, `end → agent_end`, `stop → session_shutdown`
- [ ] Rest is the prompt
- [ ] Auto-name as in `/routine`
- [ ] Call `createRoutine` with hook trigger
- [ ] Refuse to create an `agent_end` hook if one already exists (the
  `createRoutine` helper enforces this; surface the error nicely)

### Step 4: `src/commands/routines.ts` — `/routines`

- [ ] No arguments
- [ ] Reads `runtime.store.routines`, formats as table
- [ ] If empty: "No active routines. Try `/routine-install ci-watch`."
- [ ] Post via `pi.sendMessage` as a system message

### Step 5: `src/commands/routine-stop.ts` — `/routine-stop <id|name>`

- [ ] Provide `getArgumentCompletions(prefix)` returning current routine
  names that start with `prefix` for tab-completion
- [ ] Call `deleteRoutine(arg, runtime)`
- [ ] Confirm or error

### Step 6: `src/commands/routine-install.ts` — `/routine-install <template>`

- [ ] Provide `getArgumentCompletions(prefix)` returning template names from
  `templates/` directory that start with `prefix`
- [ ] Read `templates/<name>.json` (sanitize `<name>` against `[a-z0-9-]+`)
- [ ] Parse as JSON; verify minimally that it conforms to `RoutineTemplate`
  (presence of required fields). On invalid: error with the parse error.
- [ ] For each entry in `requiredTools`: run `which <tool>` via `pi.exec`.
  If missing: warn but proceed.
- [ ] Build a `RoutineCreate` input from the template (parsing the interval
  if pulse) and call `createRoutine`
- [ ] On success: post confirmation with the routine's next-fire time and a
  hint to use `/routines` to inspect

### Step 7: `src/commands/routine-export-cron.ts` — `/routine-export-cron <name>`

- [ ] Resolve routine by name; error with hint if not found
- [ ] Generate output (printed via `pi.sendMessage`):
  1. A `crontab` line with `pi --print` invocation
  2. A `launchd` plist body
  3. The prompt file content
- [ ] Write the prompt file to
  `${HOME}/.pi/routines/prompts/<name>.txt` (mkdir -p as needed)
- [ ] Write the plist to
  `${HOME}/.pi/routines/launchd/com.pi-routines.<name>.plist`
- [ ] Cron schedule conversion:
  - Pulse with interval `<= 60m`: `*/<minutes> * * * *` (rounded down,
    minimum `*/1`)
  - Pulse with interval `> 60m`: refuse and instruct user to set a daily cron
    manually (this command targets daily-or-less-frequent routines best;
    pulse-style 5m doesn't really need persistence)
  - Hook routines: refuse with explanation — hooks fire on Pi events, not
    time; they can't be exported to cron
- [ ] The command writes files to disk; **do not** modify the user's crontab
  or load the launchd job automatically. Output instructions only.

### Step 8: Testing & Verification

> ZERO failures.

- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm test` exits 0
- [ ] All six commands compile and their `registerXCommand` functions exist
- [ ] `_mutate.ts` is the single source of mutation truth (grep for direct
  `runtime.store.routines[id] =` assignments outside `_mutate.ts` — there
  should be none after this task)

### Step 9: Documentation & Delivery

- [ ] File-header JSDoc on every new file
- [ ] Update `taskplane-tasks/CONTEXT.md` Discoveries with:
  - The `_mutate.ts` extraction
  - Any parsing edge cases discovered (e.g., multi-word interval handling)

## Documentation Requirements

**Must Update:**
- `taskplane-tasks/CONTEXT.md` — Discoveries

**Check If Affected:**
- `PLAN.md` — do not modify

## Completion Criteria

- [ ] All 6 command files exist with their register functions
- [ ] `_mutate.ts` exists and is the single source of mutation truth
- [ ] Tools from TP-005 now delegate to `_mutate.ts`
- [ ] `pnpm typecheck` zero errors

## Git Commit Convention

- **Step completion:** `feat(TP-007): complete Step N — description`
- **Bug fixes:** `fix(TP-007): description`
- **Refactors:** `refactor(TP-007): description`

## Do NOT

- Subscribe to lifecycle events (`session_start`, etc.) — those are TP-006
- Duplicate create/delete logic between tools and commands (the whole point
  of Step 1 is the shared helper)
- Modify the user's crontab automatically — only output instructions
- Make `/routine-export-cron` mandatory or smart about it; v1 is "print the
  config the user pastes manually"

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues are discovered during execution. -->
