# Changelog

All notable changes to `pi-routines` are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

## 0.4.0 — 2026-07-06

Minor release: lifecycle fixes and Claude Code Routines parity improvements.
No schema bump and no breaking changes.

### Added

- **Claude-style API fire compatibility.** API routines now accept
  `POST /routines/<id>/fire` in addition to the existing `/trigger` route.
  Routines with `allowArgs: true` may receive `{"text":"..."}` payloads;
  the prompt sees them as `{apiArgs}` with shape `{"text":"..."}`.
- **Per-fire queue payloads.** API and GitHub fires can now queue multiple
  independent runs for the same routine without overwriting each other's
  `{apiArgs}` or `{githubEvent}` payloads.
- **GitHub batch fan-out.** When a poll observes multiple fresh matching
  events, each event queues its own fire in chronological order, closer to
  Claude Code Routines' one-session-per-event behavior.
- **Skipped-run audit trail for paused automatic fires.** Scheduler, hook,
  and API fire attempts against paused routines now record `skipped` runs
  with reason `paused` while still consuming zero provider tokens.

### Fixed

- **`once: "per_session"` lifecycle hooks.** The guard now uses in-memory
  session state instead of persisted `tickState`, so routines such as
  `session-wrap` keep firing once per new pi session after their first-ever
  run.
- **Multiple `session_start` hooks.** Startup hooks now queue through the
  normal FIFO drain path instead of directly competing for the active-turn
  guard.
- **Widget refresh lifecycle.** The periodic status refresh starts after the
  persisted store loads and restarts after routine creation, so pre-existing
  timed routines update correctly after startup.
- **Reload/session reset cleanup.** Session startup now stops old scheduler
  handles and widget refresh before reloading persisted state.
- **Quiet-mode suppression.** The `[~]` response is only collapsed for
  routines configured with `quiet: true`; verbose routines that emit `[~]`
  remain visible in the transcript.

### Documentation

- Updated README, SKILL.md, and the one-off template wording to reflect
  `/fire` compatibility, print-mode behavior, spent one-off triggers, and
  the 0.4.0 release version.

### Tests

193 / 193 passing (was 185 in 0.3.1). Added regression coverage for hook
lifecycle behavior, quiet-mode suppression, Claude-style API payloads,
paused-fire skip records, and GitHub event batch fan-out.

## 0.3.1 — 2026-05-21

Patch release: bug fixes uncovered by three self-audit passes after 0.3.0
shipped. No new features, no schema bump, no breaking changes.

### Fixed

- **Critical: `saveStore` concurrent-write race.** All `saveStore` callers
  shared a single `${STATE_FILE}.tmp` filename. Fire-and-forget writers
  (`recordRun`, the one-off `fired` callback, the github cursor advance)
  could corrupt the tmp file or trip `ENOENT` when one rename consumed
  the inode another writer expected. Each call now uses a unique
  `${STATE_FILE}.tmp.${randomBytes(4).toString("hex")}` filename. The
  final rename remains atomic; semantics are still "last writer wins".
  Added a regression test that fires 10 parallel saves and asserts no
  warnings + no `.tmp.*` leftovers.
- **GitHub poller now honors `paused`.** `tickGithub` was calling
  `gh api` regardless of `routine.paused`, burning the user's
  rate-limit budget on routines that couldn't fire. Now short-circuits
  at the top of the tick and re-arms at the normal interval so resume
  is instantaneous.
- **`drainQueue` now gates on `paused`.** A routine paused while queued
  (between enqueue and consumption) used to still fire. Manual fires
  (`/routine-run-now`) intentionally bypass — they're the explicit
  override path.
- **Manual fires no longer increment `runsToday`.** The pre-fire cap
  check correctly bypassed for `origin.kind === "manual"`, but the
  post-fire write-through bumped `runsToday` unconditionally. SKILL.md
  and the docs said the cap was about automatic fires — the code now
  matches.
- **`OneOffTrigger.fired` flag stops reload-time error spam.** Fired
  one-offs used to log `console.error` on every `/reload` because
  `parseOneOff` threw "in the past". One-offs are now marked `fired:
  true` after firing and silently skipped on re-arm. Legacy
  past-timestamp triggers that were never marked fired self-heal on
  next arm.
- **`recordRun` initialises `tickState` when missing.** Previously
  bailed silently, so the FIRST-ever fire of a routine — if it errored
  or was cap-skipped before the success-path write-through — silently
  dropped from `/routine-runs`.
- **`deleteRoutine` clears transient runtime state.** The deleted
  routine's queue entry, `triggerOrigin`, `apiArgs`, and
  `githubEvents` entries are now explicitly removed.
- **Test hygiene: tests no longer write to the user's real
  `~/.pi/agent/extensions/routines/state.json`.** Four test files
  (`mutate.test.ts`, `pause.test.ts`, `drain-paused.test.ts`,
  `run-history.test.ts`) used to import modules before redirecting
  `$HOME`, so `STATE_FILE` resolved to the user's real path. Confirmed
  on a cloud agent that the real state file contained leftover test
  fixtures. All four now `mkdtemp` a tmp HOME, set `process.env.HOME`
  before the dynamic `await import(...)`, and `after()` removes + restores.
- **`tests/max-runs-per-day.test.ts` cleanup actually runs.** Previous
  version used `process.on("exit", () => require("node:fs").rmSync(...))`
  which silently failed in ESM (`require` is undefined; the try/catch
  ate the `ReferenceError`). Switched to `after()` from `node:test`.
- **SKILL.md `version: 0.2.0` → `0.3.0`** to match the package; bumped
  to 0.3.1 in this release.

### Internal

- Exported `tickGithub` from `src/github-poller.ts` for test use. Driving
  it through the real `setTimeout` chain requires `mock.timers.tickAsync`,
  which isn't stable in Node 22 yet.

### Tests

185 / 185 passing (was 174 after 0.3.0 merge). 11 net new regression
tests across drain pause, one-off fired flag, `recordRun` initialisation,
`deleteRoutine` cleanup, manual-fire cap behaviour, github poller pause,
and concurrent `saveStore` writes.

## 0.3.0 — 2026-05-20

Minor release: exposes every trigger kind, adds pause/resume + daily cap.

### Added

- **All six trigger kinds reachable from every user surface.** `cron`,
  `oneoff`, `api`, and `github` were implemented in 0.2.x but no
  command, tool, template, or `/schedule` meta-prompt could create them.
  `RoutineCreate` (TypeBox schema with per-kind sub-schemas), `/schedule`
  (NL meta-prompt), and `/routine-install` (multi-trigger templates) now
  support every kind.
- **Multi-trigger routines.** `RoutineCreate` accepts a `triggers: [...]`
  array (max 4) in addition to the singular `trigger`. ANY trigger
  firing enqueues the routine once, deduped through the existing
  collapse window.
- **Pause / resume.** New `Routine.paused` flag, gated centrally in
  `scheduler.enqueueTriggerFire`, `hooks.pickHookRoutines`, and
  `server.handleRequest` (HTTP 423 Locked). New `/routine-pause` and
  `/routine-resume` slash commands plus `RoutinePause` and
  `RoutineResume` LLM tools. `/routine-run-now` intentionally bypasses
  pause.
- **`maxRunsPerDay` soft cap.** Opt-in per-routine. Enforced before any
  LLM turn opens, so capped fires consume zero provider tokens.
  Counter rolls over at local midnight. Manual fires bypass.
- **Four new bundled templates.** `morning-cron` (cron with day-cap),
  `oneoff-reminder`, `api-webhook` (uses `{apiArgs}`), `github-pr-review`
  (uses `{githubEvent}`).
- **`{githubEvent}` prompt placeholder.** Peer of the existing
  `{apiArgs}`. Carried via a transient `runtime.githubEvents` map; no
  longer pollutes the 2 KB `userState` budget.
- **Cross-platform tool probe.** `routine-install` no longer shells
  out to POSIX `which` — pure Node PATH walk with PATHEXT support on
  Windows.

### Changed

- Consolidated duplicate helpers (`resolveRoutine`, `listRoutineNames`,
  `describeTrigger`, `describeTriggers`, `relativeTime`) into single
  canonical implementations in `src/format.ts` and `src/tools/_resolve.ts`.
- README + SKILL.md rewritten with accurate counts, every trigger kind,
  prompt placeholder table, and a head-to-head comparison against
  Anthropic's Claude Code Routines.

## 0.2.1 — 2026-05-20

Documentation: advertised v0.2.0 features in README.

## 0.2.0

Cron + multi-trigger + run history + HTTP API trigger server + GitHub
trigger poller + `/schedule` natural-language command. Infrastructure
landed in 0.2.x but several trigger kinds were not yet reachable from
user-facing surfaces — fixed in 0.3.0.

## 0.1.0

Initial release: pulse + hook triggers, 7 bundled templates, 4 LLM
tools, slash commands, atomic store, recursion guard, print-mode
awareness.
