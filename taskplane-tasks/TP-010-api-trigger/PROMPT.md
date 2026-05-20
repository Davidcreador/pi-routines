# Task: TP-010 — API Trigger (Local HTTP Server)

**Created:** 2026-05-20
**Size:** L

## Review Level: 3 (Plan + Code + Security)

**Assessment:** Network-listening code in a developer tool. Bearer-token
auth, bind-to-loopback policy, secret storage hygiene. Needs a security
review of the token-rotation flow and the request handler.

**Score:** 7/8 — Blast radius: 3, Pattern novelty: 3 (HTTP in-process),
Security: 4 (auth + secrets), Reversibility: 1

## Canonical Task Folder

```
taskplane-tasks/TP-010-api-trigger/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Add an optional `api` trigger kind that exposes a per-routine HTTP endpoint.
An embedded `node:http` server (off by default; opt-in via
`/routine-server-start <port>`) listens on `127.0.0.1` only and accepts
`POST /routines/:id/trigger` with a `Bearer <token>` header.

## Dependencies

- **Task:** TP-008 (multi-trigger)
- **Task:** TP-009 (so each API fire records a `RoutineRun` with
  `triggerKind: "api"`)

## Context to Read First

**Tier 2:**

- `taskplane-tasks/CONTEXT.md`

**Tier 3:**

- `src/types.ts`
- `src/scheduler.ts` — `enqueue` API for triggers
- `src/store.ts` — token storage (separate file to avoid mixing secrets
  with routine state; recommended: `~/.pi/agent/extensions/routines/tokens.json`
  with mode `0600`)

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`
- **Runtime:** Node 22+, `node:http`, `node:crypto.randomBytes`

## File Scope

- `src/types.ts` (modify — add `{kind: "api"}` to `RoutineTrigger`)
- `src/server.ts` (new — http server lifecycle)
- `src/tokens.ts` (new — token storage + verify, 0600 file)
- `src/commands/routine-server.ts` (new — start/stop/status)
- `src/commands/routine-token.ts` (new — generate/rotate/show)
- `extensions/index.ts` (modify — register commands; stop server in cleanup)
- `tests/server.test.ts` (new)
- `tests/tokens.test.ts` (new)

## Security Requirements (NON-NEGOTIABLE)

- [ ] Bind to `127.0.0.1` ONLY — pass `host: "127.0.0.1"` to `server.listen`.
      Never `0.0.0.0` or unspecified.
- [ ] Reject the request if `req.socket.remoteAddress` is not loopback —
      double-check at request time (in case of misconfiguration).
- [ ] Tokens are 32-byte hex from `crypto.randomBytes(32).toString("hex")`.
- [ ] Constant-time comparison via `crypto.timingSafeEqual`.
- [ ] Token file mode `0o600`. Refuse to start server if perms are wider.
- [ ] No CORS. No `OPTIONS` handler. Reject any method other than POST.
- [ ] Reject requests >4 KiB body.
- [ ] Rate-limit: max 60 req/min per token (in-memory token bucket).
- [ ] Token NEVER logged in full — only first 8 chars + `...`.
- [ ] Server OFF by default — must be started explicitly per session.
- [ ] On `session_shutdown` and on `/reload` cleanup, the server closes.

## Steps

### Step 0: Preflight + threat model

- [ ] Document the threat model in `STATUS.md`: who could reach the
      endpoint, what they could do, what defenses exist.

### Step 1: Token store (`src/tokens.ts`)

- [ ] `generateToken(routineId): Promise<string>` — creates, persists, returns
- [ ] `verifyToken(routineId, presented): Promise<boolean>` — constant-time
- [ ] `rotateToken(routineId): Promise<string>` — replaces existing
- [ ] `revokeToken(routineId): Promise<void>`
- [ ] All writes go to `~/.pi/agent/extensions/routines/tokens.json` with `0o600`
- [ ] On read, fail loudly if file mode is wider than `0o600`

### Step 2: HTTP server (`src/server.ts`)

- [ ] `startServer(runtime, port: number): Promise<number>` — returns actual port
- [ ] `stopServer(runtime): Promise<void>` — idempotent
- [ ] Route: `POST /routines/:id/trigger`
- [ ] Headers: `Authorization: Bearer <token>`
- [ ] Body (optional): JSON `{ args?: Record<string, unknown> }` passed
      to the prompt as `{apiArgs}` template variable (sanitize: no nested
      objects > depth 3, max 1KiB stringified)
- [ ] On success: enqueue via scheduler with `triggerKind: "api"`, respond
      `202 Accepted { runId }`
- [ ] On auth fail: `401` with empty body
- [ ] On rate limit: `429`
- [ ] On missing routine: `404`

### Step 3: Trigger kind (`src/types.ts`)

- [ ] Add `{ kind: "api" }` (no fields — token is keyed by routineId)
- [ ] Optional: `{ kind: "api"; allowArgs?: boolean }` to opt-in to args passthrough

### Step 4: Slash commands

- [ ] `/routine-server start [port]` (default 7424), `/routine-server stop`,
      `/routine-server status` (shows port, uptime, request count)
- [ ] `/routine-token generate <id|name>` — prints token ONCE; warns
- [ ] `/routine-token rotate <id|name>`
- [ ] `/routine-token show <id|name>` — prints `xxxxxxxx...` (last-8 hidden)

### Step 5: Tests

- [ ] Spin up server on a random port (port 0), make real HTTP requests
- [ ] Token verify: positive case, wrong-token 401, missing-header 401
- [ ] Loopback enforcement: skip in CI if no way to spoof, document
- [ ] Rate limit: 61st request in a minute → 429
- [ ] File-mode check: write a token file with mode 0o644, expect read to throw

## Definition of Done

- [ ] All security requirements verified in tests or documented as
      manual-verified in STATUS.md
- [ ] `pnpm check` green
- [ ] Server can be started, hit with curl, stopped cleanly
- [ ] Commit: `feat(api): per-routine HTTP trigger with bearer auth (TP-010)`
