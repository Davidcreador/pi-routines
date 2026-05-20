---
name: routine
version: 0.1.0
description: Manage pi-routines — create, list, stop, and install recurring or event-driven AI prompts. Use when the user wants to schedule recurring prompts, set up a background check, install a monitoring routine, run a morning briefing, start a pomodoro, watch CI, watch deploys, babysit PRs, run a test guardian, or build a hook on session_start / agent_end / session_shutdown.
---

# Routine

pi-routines lets the agent schedule prompts that fire on a timer (`pulse`) or
on a lifecycle event (`hook`). Each fire is a normal LLM turn — the prompt is
injected into the conversation, the model responds, tools are allowed.

## When to use each tool vs slash command

Slash commands are the user surface. Tools are the LLM surface. Prefer
commands when the user is driving; use tools when the LLM is reacting.

| Intent                            | Use                                    |
| --------------------------------- | -------------------------------------- |
| User says "set up X every 10m"    | `/routine-on` (interactive)            |
| User says "install pomodoro"      | `/routine-install pomodoro`            |
| User says "show my routines"      | `/routines`                            |
| User says "stop the CI check"     | `/routine-stop ci-watch`               |
| LLM needs to create one in-flight | `RoutineCreate` tool                   |
| LLM needs to inspect state        | `RoutineList` tool                     |
| Routine self-terminates           | `RoutineDelete` tool (from its prompt) |
| Routine remembers across ticks    | `RoutineSetState` tool                 |

## Choosing pulse vs hook

- **`pulse`** — fires on an interval. Minimum 30s. Use for monitors
  (CI, deploys, PRs, tests) and check-ins (pomodoro).
- **`hook`** — fires on a lifecycle event. Use for:
  - `session_start` — onboarding, daily briefing (pair with `once: "daily"`)
  - `agent_end` — runs after every assistant turn ends (rare; usually too noisy)
  - `session_shutdown` — wrap-up, save notes (pair with `once: "per_session"`)

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

| Name               | Trigger              | Quiet | Notes                                      |
| ------------------ | -------------------- | ----- | ------------------------------------------ |
| `ci-watch`         | pulse 3m             | yes   | Requires `gh`. Alerts on CI status change. |
| `morning-briefing` | session_start daily  | no    | Git log + todo summary at first start.     |
| `pomodoro`         | pulse 25m, max 8     | no    | Focus check-in; auto-stops after 8 ticks.  |
| `deploy-watch`     | pulse 2m             | yes   | Self-deletes when deploy finishes.         |
| `session-wrap`     | session_shutdown     | no    | Writes session summary to Engram.          |
| `pr-babysitter`    | pulse 15m            | yes   | Requires `gh`. Watches your open PRs.      |
| `test-guardian`    | pulse 5m             | yes   | Re-runs the test suite during TDD.         |

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

## Common pitfalls

- **`[~]` only suppresses when `quiet: true`.** A verbose routine that emits
  `[~]` still shows up in the transcript as `[~]`. Set quiet, then use the
  token.
- **Minimum interval is 30s.** Anything shorter is rejected by `RoutineCreate`
  and `/routine-on`.
- **Max 20 active routines** per session. Old ones must be deleted to add new.
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
