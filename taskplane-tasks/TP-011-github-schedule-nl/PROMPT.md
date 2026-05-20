# Task: TP-011 — GitHub Event Trigger + `/schedule` NL Command

**Created:** 2026-05-20
**Size:** L

## Review Level: 2 (Plan + Code)

**Assessment:** Two distinct sub-features bundled for review economy.
GitHub polling is a well-trodden pattern (cursor + ETag); the `/schedule`
NL command is a thin LLM wrapper over existing `RoutineCreate`.

**Score:** 5/8 — Blast radius: 2, Pattern novelty: 2, Security: 1 (handles
`gh` output), Reversibility: 1

## Canonical Task Folder

```
taskplane-tasks/TP-011-github-schedule-nl/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Two features in one PR:

1. **GitHub trigger** — a new trigger kind that polls the `gh` CLI for
   `pull_request.opened`, `pull_request.closed` (filterable to merged-only),
   `issues.opened`, and `push` events on configured repos.
2. **`/schedule <natural language>`** — a slash command that uses the active
   LLM to parse the user's intent into a `RoutineCreate` invocation, mirroring
   Claude Code's `/schedule daily PR review at 9am` UX.

## Dependencies

- **Task:** TP-008 (multi-trigger; one routine may combine schedule + github)
- **Task:** TP-009 (run history; each github-driven fire is a recorded run)

## Context to Read First

**Tier 2:**

- `taskplane-tasks/CONTEXT.md`

**Tier 3:**

- `src/types.ts` — for `RoutineTrigger`
- `src/scheduler.ts` — for arming polling intervals
- `src/commands/routine.ts` — pattern for slash-command parsing
- `src/tools/routine-create.ts` — for invocation from `/schedule`

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, calls `gh` CLI via `node:child_process`
- **Requires `gh`** at runtime (warn, don't block, if absent)

## File Scope

- `src/types.ts` (modify — add `{kind: "github", ...}`)
- `src/github-poller.ts` (new)
- `src/schedule-nl.ts` (new — LLM prompt construction + invocation)
- `src/commands/schedule.ts` (new — `/schedule` slash command)
- `extensions/index.ts` (modify — wire poller + command)
- `tests/github-poller.test.ts` (new — mock `gh` output)
- `tests/schedule-nl.test.ts` (new — test parser logic with synthetic LLM output)

## Steps

### Step 0: Preflight

- [ ] TP-008 + TP-009 are `.DONE`
- [ ] `gh --version` available locally (note in STATUS.md if not)

### Step 1: GitHub trigger type

- [ ] Add to `src/types.ts`:
      `ts
    | {
        kind: "github";
        repo: string;                 // "owner/name"
        event:
          | "pull_request.opened"
          | "pull_request.closed"
          | "issues.opened"
          | "push";
        pollIntervalMs: number;       // min 60_000 (1m), default 120_000
        filter?: {
          labels?: string[];          // pull_request only
          branches?: string[];        // push only
          mergedOnly?: boolean;       // pull_request.closed only
        };
        cursor?: string;              // last-seen event id, persisted
      }
    `

### Step 2: Poller (`src/github-poller.ts`)

- [ ] `armGithubPoller(runtime, routine, triggerIndex): NodeJS.Timeout`
- [ ] Each tick runs `gh api` (using the user's auth) for the appropriate
      endpoint, with cursor pagination
- [ ] On new event(s), enqueue the routine with `{ githubEvent }` injected
      into the prompt as a template variable
- [ ] Persist updated cursor via `saveStore`
- [ ] Backoff on `gh` failures: 2× current poll interval, max 30m
- [ ] Catch missing `gh`: log once, disable poller for this routine, don't
      crash

### Step 3: `/schedule <natural language>` (`src/commands/schedule.ts`)

- [ ] Register slash command
- [ ] If no args: print short help
- [ ] Otherwise: build a meta-prompt that asks the LLM to emit a JSON
      object matching the `RoutineCreate` tool args
- [ ] Use `pi.runLLM` (or equivalent) with a tool-restricted single turn —
      the LLM should call `RoutineCreate` directly. Implementation note: the
      simplest path is to inject a system message naming `RoutineCreate` as
      the only tool and prompt with the user's natural-language request.
- [ ] Echo the parsed routine for confirmation; allow user to cancel via
      a follow-up `/routine-stop <name>` (no inline confirmation in v1)

### Step 4: Tests

- [ ] `tests/github-poller.test.ts` — mock `gh` via a stubbed
      `child_process.spawn` that returns canned JSON; assert cursor advance
      and enqueue
- [ ] `tests/schedule-nl.test.ts` — feed a synthetic LLM JSON response and
      assert it produces a valid `RoutineCreate` args object that passes
      the tool's TypeBox schema

## Definition of Done

- [ ] All steps green
- [ ] `pnpm check` green (≥75 tests total)
- [ ] Manual smoke (noted in STATUS.md):
      `/schedule every weekday at 9am summarize my open PRs` creates a
      working cron routine
- [ ] Commit: `feat(triggers): github events + /schedule NL command (TP-011)`
