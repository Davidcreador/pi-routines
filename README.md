# pi-routines

[![release](https://img.shields.io/github/v/release/Davidcreador/pi-routines)](https://github.com/Davidcreador/pi-routines/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

A [**pi**](https://github.com/earendil-works/pi-coding-agent) extension that gives
your agent **scheduled and event-driven routines** — check CI every 5 minutes,
brief you at session start, summarize your day at shutdown, run a pomodoro
timer, react to a GitHub PR, or fire from a webhook.

No daemon. No external scheduler. No cloud. Routines run **inside your live pi
session** as normal LLM turns, with full tool access, on your model
credentials, with state that never leaves your machine.

---

## Features

- 🕒 **Six trigger kinds**, freely mixable on the same routine (max 4 per routine):
  - `pulse` — fixed interval, minimum 30 s
  - `cron` — 5-field POSIX cron with timezone support
  - `oneoff` — fire once at an ISO-8601 timestamp, then mark that trigger spent
  - `hook` — pi lifecycle events (`session_start` / `agent_end` / `session_shutdown`) with `once: daily|per_session`
  - `api` — `POST 127.0.0.1:7424/routines/<id>/trigger` (or Claude-style `/fire`) with a bearer token (off by default)
  - `github` — polled `gh` events: `pull_request.opened|closed`, `issues.opened`, `push`, with label / branch / merged filters
- 📦 **11 bundled templates** — `ci-watch`, `pomodoro`, `morning-briefing`, `morning-cron`, `deploy-watch`, `session-wrap`, `pr-babysitter`, `test-guardian`, `api-webhook`, `oneoff-reminder`, `github-pr-review`
- ⏯ **Pause / resume** — `/routine-pause` and `/routine-resume` keep the routine in the store with full run history but silence every fire path (scheduler / hooks / api → 423 Locked). Manual `/routine-run-now` bypasses the pause.
- 🛡 **`maxRunsPerDay` soft cap** — opt-in per-routine daily limit; capped fires are recorded as `skipped` runs and **consume zero provider tokens** (gated before any LLM turn opens)
- 🔇 **Silent mode** — quiet routines whose response is exactly `[~]` are suppressed from chat
- 💾 **Persistent state** — serialized, generation-safe `0600` writes (`.tmp` → rename) with `.bak`; malformed routines are quarantined
- 🧠 **LLM tools** — the agent can create / list / delete / update routines and persist arbitrary state across ticks
- 🎛 **Slash commands** — full user-facing UI: `/routine`, `/routines`, `/routine-install`, `/routine-pause`, …
- 🔁 **Hot-reload safe** — `globalThis.__piRoutinesCleanup` stops old timers + servers before re-arming
- 🖨 **Print-mode aware** — registers tools but skips timers/widget/hook fires in `pi --print`
- 🪞 **Prompt placeholders** — `{cwd}`, `{date}`, `{time}`, `{state}`, `{tickCount}`, `{apiArgs}` (api triggers), `{githubEvent}` (github triggers)

---

## How does this compare to Claude Code Routines?

Anthropic's own [Claude Code Routines](https://code.claude.com/docs/en/routines) (research preview, April 2026) live in their cloud. `pi-routines` is the **local, in-session counterpart**. They solve different shapes of the same problem.

|                          | Claude Code Routines (cloud)                  | `pi-routines` (this extension)                     |
| ------------------------ | --------------------------------------------- | -------------------------------------------------- |
| Where it runs            | Anthropic-managed cloud session               | Inside your live pi session, on your machine       |
| Always-on / laptop closed | Yes                                          | No — only while pi is running                      |
| Min cadence              | **1 hour**                                    | **30 seconds**                                     |
| Schedule kinds           | recurring presets + cron (via `/schedule update`) + one-off | `pulse`, `cron`, `oneoff` — all three              |
| API trigger              | `POST .../v1/claude_code/routines/<id>/fire`  | `POST 127.0.0.1:7424/routines/<id>/trigger` or `/fire`, off by default |
| GitHub trigger           | Webhook from Claude GitHub App, PR + Release events | Polled via your local `gh` CLI; PR/issues/push    |
| Session-lifecycle hooks  | None (cloud has no session boundary)          | **`session_start` / `agent_end` / `session_shutdown` with `once: daily \| per_session`** |
| State across ticks       | None (each run is fresh)                      | **`RoutineSetState` + `userState` (≤ 2 KB JSON)**   |
| Silent / quiet mode      | None                                          | `quiet: true` + `[~]` token + suppressor            |
| Connectors / tools       | Account MCP connectors                        | Whatever tools your pi session has                  |
| Daily cap                | 5 / 15 / 25 by plan                           | Opt-in per-routine `maxRunsPerDay` (default: unlimited) |
| Cost model               | Counts against subscription                   | Your own provider tokens via pi                     |
| Privacy                  | Code + secrets uploaded to Anthropic          | Stays local                                         |
| Discoverability          | Web UI + `/schedule`                          | 13 slash commands + 6 LLM tools + bundled skill     |
| Manage from web GUI      | Yes                                           | No                                                  |

Pick the cloud one when you need the routine to run while your laptop is closed. Pick `pi-routines` when you need sub-hourly cadences, session-lifecycle hooks, state across ticks, or on-device privacy.

---

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) ≥ 0.75.3
- Node.js ≥ 22
- [pnpm](https://pnpm.io/) (or npm / yarn — the lockfile is pnpm but any will work)
- Optional: `gh` CLI for GitHub-triggered routines

---

## Install

### Quick install (recommended — via the `pi` CLI)

If you don't have pi yet:

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or
npm install -g @earendil-works/pi-coding-agent
```

Then install this package:

```bash
# From npm (recommended)
pi install npm:@davecodes/pi-routines

# Pinned version
pi install npm:@davecodes/pi-routines@0.4.0

# Or directly from GitHub
pi install git:github.com/Davidcreador/pi-routines
pi install git:github.com/Davidcreador/pi-routines@v0.4.0
```

Project-local install (writes to `.pi/npm/` or `.pi/git/` instead of `~/.pi/agent/`):

```bash
pi install -l npm:@davecodes/pi-routines
```

Restart pi (or run `/reload`) — the extension auto-loads. You'll see new slash
commands (`/routine`, `/routines`, `/routine-install`, …) and a footer widget
showing active routine count.

> ⚠️ **Security:** pi packages run with full system access. Review the source
> before installing third-party packages.

### Manage the package

```bash
pi list                                    # show installed packages
pi update npm:@davecodes/pi-routines       # update this package
pi remove npm:@davecodes/pi-routines       # uninstall
pi config                                  # enable/disable extensions, skills
```

### Manual install (alternative — for development or pinned local paths)

```bash
git clone https://github.com/Davidcreador/pi-routines.git
cd pi-routines
pnpm install
```

Then register the absolute path in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-routines"]
}
```

> 💡 Back up first: `cp ~/.pi/agent/settings.json{,.bak}`. Restart pi after editing.

### Uninstall (manual install)

Remove the path from `~/.pi/agent/settings.json` and restart pi. Optionally
delete persisted state: `rm ~/.pi/agent/extensions/routines/state.json`.

---

## 30-Second Tour

```bash
# Install a bundled "ci-watch" routine (polls CI every 3 minutes)
/routine-install ci-watch

# Install a "morning-briefing" routine (fires once per day on session_start)
/routine-install morning-briefing

# Install a pomodoro check-in (every 25m, up to 8 ticks)
/routine-install pomodoro

# Ad-hoc pulse: every 30 seconds, do a thing
/routine 30s remind me to drink water

# Ad-hoc hook: capture shutdown context and summarize it next session
/routine-on session_shutdown summarize what I did this session

# Natural language: pi figures out the right trigger + writes a prompt
/schedule every weekday at 9am summarize my open PRs
/schedule when a PR opens on Davidcreador/pi-routines, leave review notes
/schedule in 2 weeks open a cleanup PR for the feature flag

# Pause + resume without losing run history
/routine-pause ci-watch
/routine-resume ci-watch

# List active routines (paused / quiet / day-cap flags shown in FLAGS column)
/routines

# Stop one by name
/routine-stop ci-watch
```

---

## Slash Commands

### Create & manage

| Command | Purpose |
| --- | --- |
| `/routine <interval> <prompt>` | Create a **pulse** routine. e.g. `/routine 10m check the build` |
| `/routine-on <event> <prompt>` | Create a **hook** routine. Events: `session_start`, `agent_end`, `session_shutdown` |
| `/schedule <natural language>` | LLM-powered routine creation — supports every trigger kind, including cron, oneoff, api, and github. e.g. `/schedule weekdays at 9am summarize my open PRs` |
| `/routines` | List active routines (id, name, triggers, last status) |
| `/routine-install <template> [owner/repo]` | Install a bundled template; GitHub placeholders require a repository |
| `/routine-pause <id\|name>` | Pause a routine without deleting it (keeps tickState + run history) |
| `/routine-resume <id\|name>` | Resume a paused routine |
| `/routine-stop <id\|name>` | Stop and delete a routine |
| `/routine-export-cron <name>` | Export an exactly representable pulse routine as a prompt file + cron/launchd configuration |

### Run control & history

| Command | Purpose |
| --- | --- |
| `/routine-run-now <id\|name>` | Fire a routine immediately, bypassing schedule and pause |
| `/routine-runs <id\|name> [--limit N]` | Show recent runs: time, trigger, status (incl. `skipped` w/ reason), duration, snippet |

### HTTP API server (for `api` triggers)

| Command | Purpose |
| --- | --- |
| `/routine-server start [port]` | Start local API server (default `7424`, `127.0.0.1` only, off by default) |
| `/routine-server stop` | Stop the local API server |
| `/routine-server status` | Show port, uptime, request count |
| `/routine-token generate <id\|name>` | Generate a bearer token (shown once) |
| `/routine-token rotate <id\|name>` | Rotate the bearer token |
| `/routine-token show <id\|name>` | Show token preview (first 8 chars only) |
| `/routine-token revoke <id\|name>` | Revoke a routine's bearer token |

API triggers accept both the native route and a Claude Code-style route:

```bash
POST http://127.0.0.1:7424/routines/<id>/trigger
POST http://127.0.0.1:7424/routines/<id>/fire
```

When the routine has `allowArgs: true`, callers may send either
`{"args": {...}}` or `{"text": "..."}`. The `text` form is exposed to the
prompt as `{apiArgs}` with shape `{"text":"..."}`.

---

## Bundled Templates

| Template            | Trigger                          | What it does                                                             |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `ci-watch`          | pulse 3m                         | Polls CI for the current branch; alerts on status change. Requires `gh`. |
| `pomodoro`          | pulse 25m, 8×                    | Focus check-in: progress, rabbit holes, next 25-min suggestion.          |
| `morning-briefing`  | `session_start` (once daily)     | Git log summary + todo file scan + 3-bullet day-plan.                    |
| `morning-cron`      | cron `0 9 * * 1-5`               | Same shape as `morning-briefing` but fires on a real cron at 9am weekdays, capped at 1 run/day. |
| `deploy-watch`      | pulse 2m                         | Monitors a deploy URL or process; alerts on failure or success.          |
| `session-wrap`      | deferred `session_shutdown`      | Captures the ended transcript and summarizes it at the next interactive start. |
| `pr-babysitter`     | pulse 15m                        | Watches your open PR for new reviews/comments.                           |
| `test-guardian`     | pulse 5m                         | Re-runs the failing test you're working on; alerts when it passes.       |
| `api-webhook`       | api with `allowArgs: true`       | Receives a webhook payload and acts on it. Demonstrates `{apiArgs}`.     |
| `oneoff-reminder`   | oneoff                           | Fires once at the timestamp you edit into the template, then marks that trigger spent. |
| `github-pr-review`  | github `pull_request.opened`     | Install as `/routine-install github-pr-review owner/repo`. Requires `gh`. |

---

## Prompt placeholders

Inside a routine's `prompt` string, the following placeholders are substituted on every fire:

| Placeholder | Value |
| --- | --- |
| `{cwd}` | Current working directory of the pi session |
| `{date}` | Today's date (locale string) |
| `{time}` | Current time (locale string) |
| `{state}` | JSON of `userState` (the LLM-writable per-routine memory) |
| `{tickCount}` | The fire number (1-indexed) |
| `{apiArgs}` | JSON of the API payload — set only when an `api` trigger fired with `allowArgs: true`. Otherwise `{}`. |
| `{githubEvent}` | JSON of the most recent GitHub event payload that triggered the fire. Otherwise `{}`. |

Oversized `userState` (> 2 KB serialized) is replaced with `{}` and the prompt gets a `[state truncated]` note appended.

---

## LLM Tools

The agent itself can manage routines via these tools (use them from a routine
prompt or any conversational turn):

| Tool              | Purpose                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `RoutineCreate`   | Create or update a routine. Accepts pulse / cron / oneoff / hook / api / github triggers (singular or multi-trigger array). |
| `RoutineList`     | List active routines                                                           |
| `RoutineDelete`   | Stop and remove a routine (often used from within a routine to self-terminate) |
| `RoutinePause`    | Pause a routine (e.g. self-suspend after a terminal condition)                 |
| `RoutineResume`   | Resume a previously paused routine                                             |
| `RoutineSetState` | Persist arbitrary state between ticks (e.g. "last CI status I reported")       |

See [`skills/routine/SKILL.md`](./skills/routine/SKILL.md) for the full LLM-facing
guide that pi auto-injects when relevant.

---

## State & Files

| Path                                          | Purpose                                                              |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `~/.pi/agent/extensions/routines/state.json`  | Persistent routines + per-routine tick state (atomic write + `.bak`) |
| `~/.pi/agent/extensions/routines/tokens.json` | API bearer tokens, `0600` mode enforced                              |
| `~/.pi/routines/prompts/<name>.txt`           | `routine-export-cron` writes per-routine prompt files here           |
| `~/.pi/routines/launchd/com.pi-routines.<name>.plist` | `routine-export-cron` writes macOS launchd plists          |

State is **fault-tolerant**: corrupt JSON or missing file → empty store; valid
JSON is shape-validated and invalid routines are ignored individually.
Disk-full / permission errors on save → log to stderr, keep running with
in-memory state. State and token files are written with owner-only `0600` mode.

---

## Design Notes

- **One in-flight routine turn at a time** (`isRoutineTurnActive` flag). Routines
  queue if they overlap.
- **Three-level recursion guard** — flag + input-source tag + depth check prevents
  a routine from triggering another routine.
- **`session_shutdown` hooks are deferred on real quit.** Pi disposes the
  session after shutdown handlers, so the extension stores a bounded transcript
  snapshot and runs the hook at the next interactive session. Reload does not
  create a deferred fire.
- **At most one `agent_end` hook fires per user-driven turn** — protects against
  loops when a routine's response triggers `agent_end` itself. Enforced both
  globally (across routines) and within a single routine's trigger list.
- **`maxRunsPerDay` is gated before any LLM turn opens.** Capped fires consume
  no provider tokens. Counter resets at local midnight. Manual fires bypass.
- **Pause keeps timers armed** so `/reload` is cheap. The pause gate lives in
  `scheduler.enqueueTriggerFire`, `hooks.pickHookRoutines`, and `server.handleRequest`
  (returns 423 Locked).
- **Print mode** (`pi --print`) registers tools but skips timers, widget, and hook
  fires — safe for one-shot CLI use.
- **Hot-reload safe** — `globalThis.__piRoutinesCleanup` stops old timers + the HTTP
  server before the new instance arms its own on `/reload`.
- **Silent mode** — routines marked `quiet: true` whose response is exactly `[~]` are
  suppressed from chat output (still counted as a tick; status recorded as `silent`).
- **HTTP server defense-in-depth** — 127.0.0.1 bind, per-request loopback re-check,
  Host header allowlist, 4 KiB body cap, per-token leaky bucket, `timingSafeEqual`.

---

## Development

```bash
pnpm typecheck   # tsc --strict --noEmit
pnpm lint        # biome check
pnpm lint:fix    # biome check --write
pnpm format      # biome format --write
pnpm test        # node:test runner
pnpm check       # typecheck + lint + test (all gates)
```

Run inline parser self-tests: `pnpm test:smoke`.

---

## Project Layout

```
pi-routines/
├── extensions/index.ts        # entry point — wires everything
├── src/
│   ├── types.ts               # source of truth for all types + constants
│   ├── store.ts               # validated, serialized state.json + v1/v2→v3 migration
│   ├── parser.ts              # interval / cron / oneoff parsing
│   ├── scheduler.ts           # timer + queue management
│   ├── executor.ts            # prompt assembly, fire, run recording
│   ├── suppressor.ts          # [~] silent-mode detection
│   ├── widget.ts              # footer status widget
│   ├── guard.ts               # recursion guard primitives
│   ├── hooks.ts               # session lifecycle handlers
│   ├── github-poller.ts       # `gh` polling for github triggers
│   ├── server.ts              # 127.0.0.1 HTTP server for api triggers
│   ├── tokens.ts              # bearer tokens (0600, timingSafeEqual)
│   ├── schedule-nl.ts         # /schedule NL → RoutineCreate meta-prompt
│   ├── format.ts              # describeTrigger, relativeTime — shared formatters
│   ├── path-probe.ts          # cross-platform `which` replacement
│   ├── tools/                 # 6 LLM tools + _mutate.ts + _resolve.ts
│   └── commands/              # 13 slash commands
├── templates/                 # 11 bundled routine templates
├── skills/routine/            # LLM-facing skill doc
└── tests/                     # node:test regression suites
```

---

## Contributing

PRs welcome. Before submitting:

1. `pnpm check` must pass (typecheck + lint + tests)
2. New routines/tools/commands need a test in `tests/`
3. Follow the existing JSDoc style on exported types

---

## License

MIT
