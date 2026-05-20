# Phase 2 Context — pi-routines v0.2.0

**Goal.** Close feature parity gaps with Claude Code's official Routines
feature (cloud-hosted, schedule/api/github triggers). Land four new
capabilities while keeping the in-process, no-daemon design.

**Baseline.** v0.1.0 (commit `b1123f5f`) on `main`. All tests pass:
`pnpm check` is the gate.

**Non-goals.**

- No cloud execution. Routines still run in the user's pi session.
- No GitHub App or webhook receiver. The GitHub trigger polls via the
  user's `gh` CLI.
- No persistence of run _output_ — only metadata (status, duration, head
  of stdout). Full output stays in the pi session log.

**Hard rules carried over from v0.1.0.**

- One in-flight routine turn at a time (`isRoutineTurnActive`).
- `session_shutdown` hooks fire on `reason: "quit"` only.
- At most one `agent_end` hook per user turn.
- `globalThis.__piRoutinesCleanup` clears intervals on `/reload`.
- Print mode (`pi --print`) registers tools but skips timers/widget.

**Shared file scope across TP-008…TP-011 — coordinate to avoid conflicts.**

- `src/types.ts` — type evolution (additive, never breaking)
- `src/store.ts` — schema migration helpers
- `src/scheduler.ts` — multi-trigger arming
- `extensions/index.ts` — wiring new subscribers

Each task owns the files in its **File Scope** section. Anything in shared
scope must be merge-friendly: prefer pure additions, document any field
rename in PR description.

**Versioning.** This phase ships as `v0.2.0` (minor bump — additive
features, no breaking API changes to existing routines).
