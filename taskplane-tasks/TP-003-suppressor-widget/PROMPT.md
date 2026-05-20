# Task: TP-003 — Suppressor & Widget

**Created:** 2026-05-19
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Two small self-contained modules. Suppressor mutates assistant
messages via `message_end` — needs plan review for the replacement contract.
Widget is purely cosmetic and side-effect-free for non-UI sessions.

**Score:** 2/8 — Blast radius: 1, Pattern novelty: 1 (message replacement is a
slightly novel use of `message_end`), Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-003-suppressor-widget/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Build the two UI-side concerns: (1) detect the `[~]` silence token in
assistant responses to quiet routines and replace the message with a compact
status line; (2) maintain a footer status line showing active routine state.

## Dependencies

- **Task:** TP-001 (types and constants)

## Context to Read First

**Tier 2 (area context):**
- `taskplane-tasks/CONTEXT.md`

**Tier 3:**
- `PLAN.md` — Phases 7 (Suppressor) and 8 (Widget)
- `src/types.ts` — for `SILENT_TOKEN`, `RoutineRuntimeState`

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, ESM, TypeScript strict

## File Scope

- `src/suppressor.ts` (new)
- `src/widget.ts` (new)

## Steps

### Step 0: Preflight

- [ ] TP-001 complete
- [ ] `src/types.ts` exports `SILENT_TOKEN` and `RoutineRuntimeState`

### Step 1: `src/suppressor.ts`

Implement exactly as specified in `PLAN.md` Phase 7.

- [ ] Export `registerSuppressor(pi, runtime): void`
- [ ] Subscribe to `pi.on("message_end", handler)`
- [ ] Handler logic:
  1. Return `undefined` immediately if `!runtime.isRoutineTurnActive`
  2. Return `undefined` immediately if `event.message.role !== "assistant"`
  3. Extract concatenated text from `event.message.content`. If no text blocks
     present: return `undefined`.
  4. If the trimmed text does NOT start with `SILENT_TOKEN`: return `undefined`
     (LLM had something to say even if it included `[~]`)
  5. Build replacement: single-line text like
     `↺ <name> · quiet · tick <n> · <HH:MM>`
     using `runtime.activeRoutineName` and the latest tickCount from
     `runtime.store.tickState[<id>]`. Look up by name → id since the runtime
     stores the active name. If lookup fails, use `"routine"` as fallback.
  6. Return `{ message: { ...event.message, content: [{ type: "text", text: <replacement> }] } }`
- [ ] Export a helper `extractText(message): string` used in step 3 above
- [ ] `pnpm typecheck` passes

**Edge cases to cover (verify in code review):**

- LLM outputs `"[~] but also FYI the build is fine"` → suppression does NOT
  apply because text after trim does start with `[~]`. The check should be
  `text.trim() === SILENT_TOKEN` (exact equality) — NOT `startsWith`. Fix the
  plan accordingly; document this in an Amendment.
- Message has multiple text blocks → join with `\n` for the trim check
- Message has image blocks only → no text, return `undefined`

**Artifacts:**
- `src/suppressor.ts` (new)

### Step 2: `src/widget.ts`

Implement exactly as specified in `PLAN.md` Phase 8.

- [ ] Export `updateWidget(runtime, ctx): void` — recomputes status text and
  calls `ctx.ui.setStatus("routines", text)`. No-op if `!ctx.hasUI`.
- [ ] Export `startWidgetRefresh(runtime, getCtx, intervalMs?): () => void` —
  starts a low-frequency interval (default 10s) that calls `updateWidget` to
  keep "next fire in Xm" countdowns accurate. Returns a stop function. If no
  pulse routines are active, returns a no-op stop function and does NOT start
  the interval.
- [ ] Export `clearWidget(ctx): void` — calls `ctx.ui.setStatus("routines", undefined)`
- [ ] Status text format: `↺ <N> active  <name1>(<status1>) · <name2>(<status2>) ...`
  - For quiet routines: `(q·<tickCount>)`
  - For verbose pulse: `(<minutes>m)` time-until-next
  - For hooks: `(<event>)` short event tag
  - Truncate names over 12 chars with `…`
  - Cap at 3 displayed; show `+N more` for the rest
- [ ] `pnpm typecheck` passes

**Edge cases:**

- `runtime.store.routines` is empty → call `clearWidget(ctx)`, do not display
  the banner
- `ctx.hasUI === false` → all functions are no-ops
- Pulse routine with `setInterval` started but `tickState` missing →
  treat as `tickCount: 0`, time-until-next derived from `interval - (Date.now() - createdAt) % interval`
- Concurrent calls to `startWidgetRefresh` from a hot reload → ensure the
  first call's interval can be cleared before the second starts. The returned
  stop function must be idempotent.

**Artifacts:**
- `src/widget.ts` (new)

### Step 3: Testing & Verification

> ZERO test failures allowed.

- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm test` exits 0
- [ ] Imports resolve cleanly

### Step 4: Documentation & Delivery

- [ ] File-header JSDoc on both modules
- [ ] If the `text.trim() === SILENT_TOKEN` correction was needed, log it in
  `taskplane-tasks/CONTEXT.md` Discoveries

## Documentation Requirements

**Must Update:**
- `taskplane-tasks/CONTEXT.md` — Discoveries table

**Check If Affected:**
- `PLAN.md` — do not modify; log via Amendment

## Completion Criteria

- [ ] All steps complete
- [ ] `pnpm typecheck` zero errors
- [ ] Both source files exist with documented APIs

## Git Commit Convention

- **Step completion:** `feat(TP-003): complete Step N — description`
- **Bug fixes:** `fix(TP-003): description`

## Do NOT

- Subscribe to events other than `message_end` (suppressor) here
- Touch `setFooter` (custom footer component) — use `setStatus` only.
  This is intentional: `setStatus` plays nice with other extensions; `setFooter`
  would clobber them.
- Implement the recursion guard logic — that lives in `src/guard.ts` (TP-001)
- Manage timers other than the widget refresh interval

---

## Amendments (Added During Execution)

### A1 — Suppressor exact-equality check (2026-05-20)

PLAN.md Phase 7 specified `text.trimStart().startsWith(SILENT_TOKEN)`. PROMPT
edge-case section explicitly overrode this to require `text.trim() === SILENT_TOKEN`.
Implementation follows the PROMPT. Documented in `src/suppressor.ts` file header.

### A2 — AgentMessage type import (2026-05-20)

`@earendil-works/pi-coding-agent` does not re-export `MessageEndEvent` or
`AgentMessage` from its package root, and `package.json#exports` only exposes
`.` and `./hooks`. Rather than reach into an unsupported sub-path, suppressor
duck-types the message as `{ role: string; content: unknown }` for the
text-extraction path. The handler spreads `event.message` to preserve all
other fields (api, provider, model, usage, …) in the replacement.
