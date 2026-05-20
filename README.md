# pi-routines

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for
**scheduled and event-driven routines** — give your Pi session the ability
to check CI every five minutes, brief you at session start, or summarise
your day at shutdown.

Two kinds of routines:

- **Pulse** — fires on a fixed interval (`every 5m`, `every 30s`,
  `every 1h30m`).
- **Hook** — fires on a pi lifecycle event (`session_start`, `agent_end`,
  `session_shutdown`).

State persists to `~/.pi/agent/extensions/routines/state.json`. Routines
survive restarts; in-memory timers restart fresh on each `session_start`.

## Install

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Register the extension in your pi settings (`~/.pi/agent/settings.json`):

   ```json
   {
     "extensions": ["/absolute/path/to/pi-routines"]
   }
   ```

   _(Back up `settings.json` first — `cp ~/.pi/agent/settings.json{,.bak}`.)_

3. Restart pi. The extension loads automatically; `/routine`, `/routines`,
   `/routine-install`, `/routine-on`, `/routine-stop`, and
   `/routine-export-cron` become available.

## 30-second tour

```text
# Install a bundled "ci-watch" routine (polls `gh` for failing checks every 5m).
/routine-install ci-watch

# Install a "morning-briefing" routine (fires once on session_start each day).
/routine-install morning-briefing

# List active routines.
/routines

# Ad-hoc pulse: every 30s, say hi.
/routine 30s say hi

# Stop one by name.
/routine-stop say-hi
```

The LLM can also create routines on its own via the `RoutineCreate` tool
(plus `RoutineList`, `RoutineDelete`, `RoutineSetState`).

## Configuration

| Path                                         | Purpose                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `~/.pi/agent/extensions/routines/state.json` | Persistent routine + tick state. Atomic write + `.bak` rollback. |
| `~/.pi/routines/prompts/<name>.md`           | `routine-export-cron` writes per-routine prompt files here.      |
| `~/.pi/routines/launchd/<name>.plist`        | `routine-export-cron` writes optional macOS launchd plists.      |
| `templates/*.json`                           | Bundled installable routine templates.                           |

## Architecture

See [`PLAN.md`](./PLAN.md) for the full design — module layout, recursion
guard (three-level: flag + input-source tag + depth check), the
single-instance / hot-reload contract, and the edge-case matrix. Key
non-negotiables:

- One in-flight routine turn at a time (`isRoutineTurnActive` guard).
- `session_shutdown` hooks fire on `reason: "quit"` only; never on
  `"reload"`.
- AT MOST ONE `agent_end` hook fires per user-driven turn.
- Print mode (`pi --print`) registers tools but skips timers + widget +
  hook fires.
- `globalThis.__piRoutinesCleanup` ensures `/reload` clears stale
  intervals before the new instance arms its own.

## Status

`v0.1.0` candidate. Six tasks (TP-001…TP-007) land the foundation,
executor/scheduler, suppressor/widget, templates+skill, LLM tools, slash
commands, and this final wiring. No npm publish in v1 — install by local
path.
