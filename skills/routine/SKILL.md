---
name: routine
version: 0.2.0
description: Manage pi-routines — create, list, pause, stop, and install scheduled or event-driven AI prompts. Use when the user wants to schedule recurring prompts, set up a background check, install a monitoring routine, run a morning briefing, start a pomodoro, watch CI, watch deploys, babysit PRs, run a test guardian, build a hook on session_start / agent_end / session_shutdown, react to a GitHub event, accept webhook triggers, or fire something once at a specific timestamp.
---

# Routine

pi-routines lets the agent schedule prompts that fire on any of six trigger
kinds. Each fire is a normal LLM turn — the prompt is injected into the
conversation, the model responds, tools are allowed.

## When to use each tool vs slash command

Slash commands are the user surface. Tools are the LLM surface. Prefer
commands when the user is driving; use tools when the LLM is reacting.

| Intent                                  | Use                                         |
| --------------------------------------- | ------------------------------------------- |
| User says "set up X every 10m"          | `/routine` (pulse shorthand) or `RoutineCreate` |
| User says "every weekday at 9am ..."    | `/schedule` (LLM picks cron)                |
| User says "in 2 weeks remind me to ..." | `/schedule` (LLM picks oneoff)              |
| User says "when a PR opens on owner/repo, …" | `/schedule` (LLM picks github)         |
| User says "install pomodoro"            | `/routine-install pomodoro`                 |
| User says "show my routines"            | `/routines`                                 |
| User says "pause the CI check"          | `/routine-pause ci-watch`                   |
| User says "stop the CI check"           | `/routine-stop ci-watch`                    |
| LLM needs to create one in-flight       | `RoutineCreate` tool                        |
| LLM needs to inspect state              | `RoutineList` tool                          |
| Routine self-terminates                 | `RoutineDelete` tool (from its prompt)      |
| Routine self-pauses (terminal condition)| `RoutinePause` tool (from its prompt)       |
| Routine resumes a sibling               | `RoutineResume` tool                        |
| Routine remembers across ticks          | `RoutineSetState` tool                      |

## Choosing a trigger kind

- **`pulse`** — fixed interval, minimum 30 s. Use for monitors (CI, deploys, PRs, tests)
  and check-ins (pomodoro).
- **`cron`** — clock-aligned cadences (9am weekdays, first of the month). 5-field POSIX.
  Pass `timezone` when known. Prefer cron over pulse when the user mentions clock times.
- **`oneoff`** — fire once at an absolute ISO-8601 timestamp, then auto-disable.
  Use for reminders, cleanup-after-deploy, "ping me in 2 weeks".
- **`hook`** — pi lifecycle events:
  - `session_start` — onboarding, daily briefing (pair with `once: "daily"`).
  - `agent_end` — runs after every assistant turn ends. Rare; usually too noisy.
    At most one routine in the whole store may attach to `agent_end`.
  - `session_shutdown` — wrap-up, save notes (pair with `once: "per_session"`).
- **`api`** — POST to `127.0.0.1:7424/routines/<id>/trigger` with a bearer token.
  Server is off by default — instruct the user to run `/routine-server start` and
  `/routine-token generate <name>` after creation. Pass `allowArgs: true` if the
  caller will send a JSON body; reference `{apiArgs}` in the prompt.
- **`github`** — polled `gh` events. Requires the `gh` CLI authenticated on PATH.
  Reference `{githubEvent}` in the prompt. Use filters (`labels`, `branches`,
  `mergedOnly`) to narrow the fire conditions.

Multi-trigger routines: pass `triggers: [...]` (max 4). Common pattern: a
`pulse` plus an `api` trigger so the same routine runs on a schedule and on
demand.

`once` prevents re-fires within the same window. Without it, a `session_start`
hook would fire on every reload.

## Quiet vs verbose

`quiet: true` means the routine's response is suppressed from the visible
transcript UNLESS the model outputs something other than the `[~]` silent
token. Use it for monitors that only matter when something changed.

- **`quiet: true`** — CI watch, deploy watch, PR babysitter, test guardian.
  The model emits `[~]` when nothing's new; the user sees nothing.
- **`quiet: false`** (default) — pomodoro, morning briefing, session wrap.
  Every fire is meant to be read.

Rule of thumb: if the prompt has "only report if changed" or "output [~] when
nothing's new", set `quiet: true`. Otherwise leave it `false`.

## Built-in templates

Install any of these with `/routine-install <name>`.

| Name               | Trigger                       | Quiet | Notes                                      |
| ------------------ | ----------------------------- | ----- | ------------------------------------------ |
| `ci-watch`         | pulse 3m                      | yes   | Requires `gh`. Alerts on CI status change. |
| `morning-briefing` | session_start daily           | no    | Git log + todo summary at first start.     |
| `morning-cron`     | cron `0 9 * * 1-5`, day-cap 1 | no    | Same shape but on a real cron, weekdays only. |
| `pomodoro`         | pulse 25m, max 8              | no    | Focus check-in; auto-stops after 8 ticks.  |
| `deploy-watch`     | pulse 5m                      | yes   | Self-deletes when deploy finishes.         |
| `session-wrap`     | session_shutdown              | no    | End-of-session summary.                    |
| `pr-babysitter`    | pulse 10m                     | yes   | Requires `gh`. Watches your open PRs.      |
| `test-guardian`    | pulse 2m                      | yes   | Re-runs the failing test during TDD.       |
| `api-webhook`      | api with allowArgs            | no    | Demonstrates `{apiArgs}`. Tell the user how to start the server + generate a token. |
| `oneoff-reminder`  | oneoff (placeholder timestamp)| no    | User edits `fireAtIso` before installing.  |
| `github-pr-review` | github pull_request.opened    | no    | Demonstrates `{githubEvent}`. Requires `gh` and an edited `repo`. |

`requiredTools` is a warning at install time, not a block — the user can
proceed without `gh` if they accept the routine will probably fail.

## Self-terminating routines

A routine can shut itself down by calling `RoutineDelete` from its own prompt.
`deploy-watch` is the canonical example: the prompt instructs the model to
call `RoutineDelete` when deployment completes or fails. Use this pattern
whenever the routine has a natural end condition the model can recognize.

Common shapes:

- "When `<condition>` is met, call RoutineDelete with name='<self>'."
- Pair with `RoutineSetState` so the model can track progress across ticks
  before terminating.

`maxTicks` is the non-LLM-controlled version of the same idea: hard cap on
fires, decremented by the scheduler.

## Prompt placeholders

Inside `prompt`, the following placeholders are substituted on every fire:

- `{cwd}`, `{date}`, `{time}`, `{tickCount}` — context.
- `{state}` — JSON of `userState`. Capped at 2 KB; oversized state is replaced
  with `{}` and a `[state truncated]` note is appended.
- `{apiArgs}` — JSON body sent to the api trigger (only meaningful when the
  routine carries an `api` trigger with `allowArgs: true`). Otherwise `{}`.
- `{githubEvent}` — JSON payload of the GitHub event that fired this run
  (only meaningful when the routine carries a `github` trigger). Otherwise `{}`.

## Pause + daily cap

Two robustness primitives that come up often:

- **`paused`** — set via `/routine-pause` or by toggling the field on the
  routine. Pause silences every fire path (scheduler / hooks / api → 423 Locked)
  but keeps tickState and run history. Manual `/routine-run-now` ignores it.
- **`maxRunsPerDay`** — opt-in soft cap. Once `tickState.runsToday` hits the cap,
  further automatic fires are recorded as `skipped` runs with reason
  `daily cap reached`. The check is **before** the LLM turn, so capped fires
  consume zero provider tokens. Counter resets at local midnight. Manual fires
  bypass the cap.

## Common pitfalls

- **`[~]` only suppresses when `quiet: true`.** A verbose routine that emits
  `[~]` still shows up in the transcript as `[~]`. Set quiet, then use the
  token.
- **Minimum interval is 30s.** Anything shorter is rejected by `RoutineCreate`.
- **Max 20 active routines** per session, max 4 triggers per routine.
- **Pulse routines do not fire mid-turn.** A tick that lands while the agent
  is streaming is queued (max depth 3) and drained on the next `agent_end`.
- **Print mode (`pi --print`) skips pulse timers.** Routines that depend on
  timers are inert in non-interactive runs; hook-triggered ones still fire
  for `session_start`/`session_shutdown` if the run has them.
- **Sessions don't coordinate.** Two open pi sessions each schedule their own
  pulse timers from the shared `state.json`. Expect duplicate fires if the
  same routine is active in both.
- **`session_start` without `once: "daily"`** fires on every `/reload` — almost
  never what you want for a briefing.
- **State is JSON, capped at 2 KB per routine.** Use `RoutineSetState` for
  small status blobs (last CI sha, last PR list), not full logs.
- **`api` and `github` triggers require setup.** `api` needs the user to start
  the local server (`/routine-server start`) and generate a token
  (`/routine-token generate <name>`). `github` needs `gh` installed and
  authenticated. Mention this in your response when you create one.
- **`agent_end` is single-routine globally** — only one routine in the store
  may attach to it. Tell the user if they hit the conflict.
