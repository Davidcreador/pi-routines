# Changelog

All notable changes to `pi-routines` are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

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
