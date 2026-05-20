# pi-routines

[![release](https://img.shields.io/github/v/release/Davidcreador/pi-routines)](https://github.com/Davidcreador/pi-routines/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

A [**pi**](https://github.com/earendil-works/pi-coding-agent) extension that gives
your agent **scheduled and event-driven routines** — check CI every 5 minutes,
brief you at session start, summarize your day at shutdown, or run a pomodoro
timer.

No daemon. No external scheduler. Routines run inside your live pi session as
normal LLM turns, with full tool access.

---

## Features

- 🕒 **Pulse routines** — fire on a fixed interval (`30s`, `5m`, `1h30m`, `2h 15m`)
- 🪝 **Hook routines** — fire on pi lifecycle events (`session_start`, `agent_end`, `session_shutdown`)
- 📦 **7 bundled templates** — `ci-watch`, `pomodoro`, `morning-briefing`, `deploy-watch`, `session-wrap`, `pr-babysitter`, `test-guardian`
- 🔇 **Silent mode** — routines can output `[~]` to suppress chat noise when nothing changed
- 💾 **Persistent state** — survives restarts; atomic writes with `.bak` rollback
- 🧠 **LLM tools** — the agent can create / list / delete / update routines itself
- 🎛️ **Slash commands** — full user-facing UI: `/routine`, `/routines`, `/routine-install`, etc.
- 🔁 **Hot-reload safe** — `/reload` cleans up old timers before re-arming
- 🖨️ **Print-mode aware** — registers tools but skips timers/widget in `pi --print`

---

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`)
- Node.js ≥ 22
- [pnpm](https://pnpm.io/) (or npm / yarn — the lockfile is pnpm but any will work)

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
pi install npm:@davecodes/pi-routines@0.1.0

# Or directly from GitHub
pi install git:github.com/Davidcreador/pi-routines
pi install git:github.com/Davidcreador/pi-routines@v0.1.0
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

# Ad-hoc hook: on session shutdown, save my notes
/routine-on session_shutdown summarize what I did this session

# List active routines
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
| `/schedule <natural language>` | LLM-powered routine creation. e.g. `/schedule weekdays at 9am summarize my open PRs` |
| `/routines` | List active routines (id, name, triggers, last status) |
| `/routine-install <template>` | Install a bundled template by name |
| `/routine-stop <id\|name>` | Stop and delete a routine |
| `/routine-export-cron` | Export routines as standalone prompt files + optional macOS launchd plists |

### Run control & history _(v0.2.0)_

| Command | Purpose |
| --- | --- |
| `/routine-run-now <id\|name>` | Fire a routine immediately, bypassing schedule |
| `/routine-runs <id\|name> [--limit N]` | Show recent runs: time, trigger, status, duration, snippet |

### HTTP API server _(v0.2.0)_

| Command | Purpose |
| --- | --- |
| `/routine-server start [port]` | Start local API server (default `7424`, `127.0.0.1` only, off by default) |
| `/routine-server stop` | Stop the local API server |
| `/routine-server status` | Show port, uptime, request count |
| `/routine-token generate <id\|name>` | Generate a bearer token (shown once) |
| `/routine-token rotate <id\|name>` | Rotate the bearer token |
| `/routine-token show <id\|name>` | Show token preview (first 8 chars only) |

---

## Bundled Templates

| Template           | Trigger                      | What it does                                                             |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `ci-watch`         | every 3m                     | Polls CI for the current branch; alerts on status change. Requires `gh`. |
| `pomodoro`         | every 25m, 8×                | Focus check-in: progress, rabbit holes, next 25-min suggestion.          |
| `morning-briefing` | `session_start` (once daily) | Git log summary + todo file scan + 3-bullet day-plan.                    |
| `deploy-watch`     | every 5m                     | Monitors a deploy URL or process; alerts on failure or success.          |
| `session-wrap`     | `session_shutdown`           | End-of-session summary: what shipped, open threads, next session.        |
| `pr-babysitter`    | every 10m                    | Watches your open PR for new reviews/comments.                           |
| `test-guardian`    | every 2m                     | Re-runs the failing test you're working on; alerts when it passes.       |

---

## LLM Tools

The agent itself can manage routines via these tools (use them from a routine
prompt or any conversational turn):

| Tool              | Purpose                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `RoutineCreate`   | Create a pulse or hook routine                                                 |
| `RoutineList`     | List active routines                                                           |
| `RoutineDelete`   | Stop and remove a routine (often used from within a routine to self-terminate) |
| `RoutineSetState` | Persist arbitrary state between ticks (e.g. "last CI status I reported")       |

See [`skills/routine/SKILL.md`](./skills/routine/SKILL.md) for the full LLM-facing
guide that pi auto-injects when relevant.

---

## State & Files

| Path                                         | Purpose                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `~/.pi/agent/extensions/routines/state.json` | Persistent routines + per-routine tick state (atomic write + `.bak`) |
| `~/.pi/routines/prompts/<name>.md`           | `routine-export-cron` writes per-routine prompt files here           |
| `~/.pi/routines/launchd/<name>.plist`        | `routine-export-cron` optionally writes macOS launchd plists         |

State is **fault-tolerant**: corrupt JSON or missing file → empty store, log
warning, continue. Disk-full / permission errors on save → log to stderr, keep
running with in-memory state.

---

## Design Notes

- **One in-flight routine turn at a time** (`isRoutineTurnActive` flag). Routines
  queue if they overlap.
- **Three-level recursion guard** — flag + input-source tag + depth check prevents
  a routine from triggering another routine.
- **`session_shutdown` hooks fire on `reason: "quit"` only**, never on `"reload"`.
- **At most one `agent_end` hook fires per user-driven turn** — protects against
  loops when a routine's response triggers `agent_end` itself.
- **Print mode** (`pi --print`) registers tools but skips timers, widget, and hook
  fires — safe for one-shot CLI use.
- **Hot-reload safe** — `globalThis.__piRoutinesCleanup` stops old timers before
  the new instance arms its own on `/reload`.
- **Silent mode** — routines marked `quiet: true` whose response is `[~]` are
  suppressed from chat output (still counted as a tick).

---

## Development

```bash
pnpm typecheck   # tsc --strict --noEmit
pnpm lint        # biome check
pnpm lint:fix    # biome check --write
pnpm format      # biome format --write
pnpm test        # node:test runner; 44 tests
pnpm check       # typecheck + lint + test (all gates)
```

Run inline parser self-tests: `pnpm test:smoke`.

---

## Project Layout

```
pi-routines/
├── extensions/index.ts     # entry point — wires everything
├── src/
│   ├── types.ts            # source of truth for all types
│   ├── store.ts            # atomic state.json read/write
│   ├── parser.ts           # interval string → ms
│   ├── scheduler.ts        # timer management + idle queue
│   ├── executor.ts         # builds + injects routine prompts
│   ├── suppressor.ts       # [~] silent-mode detection
│   ├── widget.ts           # footer status widget
│   ├── guard.ts            # recursion guard state
│   ├── hooks.ts            # session lifecycle handlers
│   ├── tools/              # 4 LLM tools
│   └── commands/           # 6 slash commands
├── templates/              # 7 bundled routine templates
├── skills/routine/         # LLM-facing skill doc
└── tests/                  # parser + store + template tests
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
