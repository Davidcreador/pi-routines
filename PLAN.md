# pi-routines — Implementation Plan

**Goal**: Pi extension that provides in-session recurring prompts (Tier 1) and event-driven
hooks (Tier 2). No daemon. 7 built-in templates. Solid edge-case handling.

---

## Package Structure

```
pi-routines/
├── package.json
├── tsconfig.json
├── extensions/
│   └── index.ts                  # entry point, wires everything
├── src/
│   ├── types.ts                  # all shared types (source of truth)
│   ├── store.ts                  # state.json read/write + atomic saves
│   ├── parser.ts                 # interval strings → ms, cron basics
│   ├── scheduler.ts              # timer management + idle queue
│   ├── executor.ts               # builds + injects a routine prompt
│   ├── suppressor.ts             # [~] detection via message_end
│   ├── widget.ts                 # footer status widget
│   ├── guard.ts                  # recursion guard state
│   ├── hooks.ts                  # session_start, agent_end, session_shutdown handlers
│   ├── tools/
│   │   ├── routine-create.ts
│   │   ├── routine-list.ts
│   │   ├── routine-delete.ts
│   │   └── routine-set-state.ts
│   └── commands/
│       ├── routine.ts            # /routine <interval> <prompt>
│       ├── routine-on.ts         # /routine-on <event> <prompt>
│       ├── routines.ts           # /routines  (list)
│       ├── routine-stop.ts       # /routine-stop <id|name>
│       ├── routine-install.ts    # /routine-install <template>
│       └── routine-export-cron.ts
├── skills/
│   └── routine/
│       └── SKILL.md
└── templates/
    ├── ci-watch.json
    ├── morning-briefing.json
    ├── pomodoro.json
    ├── deploy-watch.json
    ├── session-wrap.json
    ├── pr-babysitter.json
    └── test-guardian.json
```

---

## Phase 1 — Types (source of truth)

**`src/types.ts`** — define everything here first. All other files import from here.

```ts
// Routine tiers
export type RoutineTier = "pulse" | "hook";

// Trigger for pulse routines
export interface PulseTrigger {
  kind: "pulse";
  intervalMs: number;       // resolved from "5m", "1h", etc.
  intervalHuman: string;    // original string, e.g. "5m"
}

// Trigger for event-hook routines
export type HookEvent =
  | "session_start"
  | "agent_end"
  | "session_shutdown";

export interface HookTrigger {
  kind: "hook";
  event: HookEvent;
  once?: "daily" | "per_session"; // guard against repeated firing
}

export type RoutineTrigger = PulseTrigger | HookTrigger;

// Context mode: what history does the LLM see when the routine fires?
// "session" = full current session (default for pulse)
// "fresh"   = no session history injected (planned for v2 via subagent)
// NOTE: v1 only supports "session". "fresh" is reserved.
export type RoutineContext = "session";

export interface Routine {
  id: string;               // nanoid, stable across renames
  name: string;             // user-facing, used in /routine-stop
  prompt: string;           // what to send to the LLM when fired
  trigger: RoutineTrigger;
  context: RoutineContext;
  quiet: boolean;           // if true, suppress [~] responses from chat
  maxTicks?: number;        // auto-delete after N fires (undefined = unlimited)
  createdAt: number;        // epoch ms
}

// Per-routine state persisted between ticks
export interface RoutineTickState {
  tickCount: number;
  lastFiredAt: number;       // epoch ms
  lastFiredDateLocal: string; // "2026-05-19" for once-daily guard
  userState: Record<string, unknown>; // arbitrary LLM-writable state (max 2KB)
}

// What gets persisted to state.json
export interface RoutineStore {
  routines: Record<string, Routine>;          // keyed by id
  tickState: Record<string, RoutineTickState>; // keyed by routine id
}

// Runtime state (not persisted)
export interface RoutineRuntimeState {
  store: RoutineStore;
  timers: Map<string, ReturnType<typeof setInterval>>; // routine id → timer
  queue: string[];            // routine ids waiting for idle slot
  isRoutineTurnActive: boolean; // recursion guard
  activeRoutineName: string | null; // which routine is currently executing
  lastUiCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | null;
}

// Parsed interval (from "5m", "1h", "30s", "90s")
export interface ParsedInterval {
  ms: number;
  human: string; // normalized, e.g. "5m", "1h 30m"
}

// Template definition (from templates/*.json)
export interface RoutineTemplate {
  name: string;          // template id, e.g. "ci-watch"
  description: string;   // one-line description
  trigger: {
    kind: "pulse";
    interval: string;    // human string, parsed at install time
  } | {
    kind: "hook";
    event: HookEvent;
    once?: "daily" | "per_session";
  };
  prompt: string;        // may contain {cwd}, {date}, {time} placeholders
  quiet: boolean;
  maxTicks?: number;
  requiredTools?: string[]; // e.g. ["gh"] — checked at install time, warns not blocks
}

// The suppression token the LLM emits to signal "nothing to report"
export const SILENT_TOKEN = "[~]";

// Max items in the fire queue (backpressure)
export const MAX_QUEUE_DEPTH = 3;

// Max per-routine userState size in bytes (JSON.stringify)
export const MAX_USER_STATE_BYTES = 2048;

// State file path
export const STATE_FILE = `${process.env.HOME}/.pi/agent/extensions/routines/state.json`;

// Templates dir (inside the package)
export const TEMPLATES_DIR = new URL("../templates", import.meta.url).pathname;
```

---

## Phase 2 — Store

**`src/store.ts`** — atomic reads/writes to `~/.pi/agent/extensions/routines/state.json`.

### Responsibilities
- Read state from disk on session_start (lazy, not on every access)
- Write state atomically (write to `.tmp` then rename) to avoid corruption
- Cache in memory; write-through on every mutation
- Recover gracefully from corrupt JSON

### Edge Cases

| Case | Handling |
|------|----------|
| File does not exist | Return empty store `{ routines: {}, tickState: {} }` |
| File is corrupt JSON | Log warning, return empty store (don't crash) |
| Concurrent writes (two Pi sessions) | Last-write-wins via atomic rename. Acceptable: routines are session-scoped in v1 |
| Disk full on write | Catch error, log to stderr, skip write (in-memory state preserved) |
| HOME not set | Fall back to `/tmp/pi-routines-state.json` |

### Key functions
```ts
export async function loadStore(): Promise<RoutineStore>
export async function saveStore(store: RoutineStore): Promise<void>
export function emptyStore(): RoutineStore
// Atomic write: write to path+".tmp", then fs.rename
async function atomicWrite(path: string, data: string): Promise<void>
```

---

## Phase 3 — Parser

**`src/parser.ts`** — interval strings → milliseconds.

### Supported formats
```
"30s"       → 30_000
"5m"        → 300_000
"1h"        → 3_600_000
"90s"       → 90_000
"1h30m"     → 5_400_000
"2h 15m"    → 8_100_000
"25 minutes"→ 1_500_000
"1 hour"    → 3_600_000
"every 5m"  → 300_000  (leading "every " stripped)
```

### Constraints
- Minimum: 30s (shorter is abusive, reject with helpful message)
- Maximum: 24h (longer should use cron export)
- Reject unknown formats with a clear error

### Edge Cases
| Case | Handling |
|------|----------|
| "0s" or negative | Error: "Interval must be at least 30 seconds" |
| "5" with no unit | Error: "Specify a unit: 5s, 5m, or 5h" |
| "2d" | Error: "Intervals over 24h should use /routine-export-cron instead" |
| Very large numbers ("9999h") | Error: "Interval too large (max 24h)" |

```ts
export function parseInterval(input: string): ParsedInterval
  // throws ParseError with a user-readable message on bad input
```

---

## Phase 4 — Scheduler

**`src/scheduler.ts`** — the core engine. Manages timers, queue, and idle detection.

### Design

```
For each pulse routine:
  setInterval(intervalMs) → on tick:
    1. if queue.length >= MAX_QUEUE_DEPTH: drop oldest entry for this routine
    2. queue.push(routineId)
    3. drain()

drain():
  while queue.length > 0:
    if !ctx.isIdle() || ctx.hasPendingMessages() || isRoutineTurnActive:
      break  // try again next tick or after agent_end
    id = queue.shift()
    fire(id)
```

### Queue draining triggers
- Timer tick (each interval)  
- `agent_end` event (LLM finished → now idle → drain)
- `tool_execution_end` event (tool done, but LLM still streaming → don't drain yet)

### Edge Cases

| Case | Handling |
|------|----------|
| Routine fires while LLM is busy | Queue (up to MAX_QUEUE_DEPTH). Drain on agent_end |
| Multiple routines queue simultaneously | Drain in FIFO order, one per idle slot |
| Same routine queues multiple times (missed ticks) | Dedup: only one entry per routine id in queue at a time |
| Routine interval shorter than LLM response time | Ticks accumulate in queue (capped), drain when idle |
| Session /reload while timer running | `session_shutdown` fires → clearInterval all timers → `session_start` re-initializes |
| setInterval drift (Node.js timer inaccuracy) | Acceptable. ±500ms irrelevant for 5m intervals. Use `Date.now()` for lastFiredAt not the tick count |
| System sleep/wake | Timer doesn't account for sleep. May fire late. That's fine. Multiple missed ticks collapse via queue dedup |
| `ctx` becomes stale after reload | Catch "Extension context no longer active" error → stop timer |
| Pi closed mid-fire | `session_shutdown` fires before OS kill (most cases) → graceful. SIGKILL skips shutdown → timer orphaned in OS, dies with process |

```ts
export function startScheduler(
  runtime: RoutineRuntimeState,
  pi: ExtensionAPI,
  getCtx: () => ExtensionContext | null
): void

export function stopScheduler(runtime: RoutineRuntimeState): void
// clearInterval on all active timers, clear queue

export function scheduleRoutine(
  routine: Routine,
  runtime: RoutineRuntimeState,
  pi: ExtensionAPI,
  getCtx: () => ExtensionContext | null
): void
// starts the interval for a single routine

export function unscheduleRoutine(
  routineId: string,
  runtime: RoutineRuntimeState
): void
// clears the interval for a single routine

export function drainQueue(
  runtime: RoutineRuntimeState,
  pi: ExtensionAPI,
  getCtx: () => ExtensionContext | null
): void
// fires queued routines if idle
```

---

## Phase 5 — Executor

**`src/executor.ts`** — builds the prompt and fires it via `pi.sendUserMessage()`.

### Prompt construction

```
[↺ routine: ci-watch · tick 3 · 14:23]
Previous state: {"lastStatus":"passing","checkedAt":"14:18"}

<user prompt text>

---
If nothing changed and there is nothing to report, respond with exactly: [~]
Do not explain that you are responding with [~]. Just output [~] and nothing else.
```

The structured prefix:
1. Makes it visually distinct in the session transcript
2. Injects tick count + time so LLM knows the temporal context
3. Injects previous state so LLM can do delta comparison
4. Appends the `[~]` instruction when `routine.quiet === true`

### The `[~]` instruction
Only appended if `quiet: true`. This is opt-in so LLM output is predictable. Users who don't set quiet get full responses every time.

### Firing
```ts
pi.sendUserMessage(prompt, { deliverAs: "nextTurn" })
```

Use `deliverAs: "nextTurn"` (not default) so it doesn't interrupt if something was queued between drain check and actual send.

### Recursion guard
Before firing: `runtime.isRoutineTurnActive = true; runtime.activeRoutineName = routine.name`
After agent_end (if it was a routine turn): reset both flags.

Tracking "was this agent turn from a routine": set in `input` event handler when `source === "extension"` and we're executing a routine.

### Edge Cases

| Case | Handling |
|------|----------|
| `maxTicks` reached | Delete routine before firing, don't fire |
| Routine deleted while queued | Check existence in queue drain, skip silently |
| `sendUserMessage` throws | Catch, log, reset guard flag, routine survives |
| userState exceeds MAX_USER_STATE_BYTES | Truncate to empty `{}` before injecting, set `[state truncated]` note |
| Prompt contains `{cwd}`, `{date}`, `{time}` | Replace with `ctx.cwd`, `new Date().toLocaleDateString()`, `new Date().toLocaleTimeString()` |

```ts
export function buildPrompt(
  routine: Routine,
  tickState: RoutineTickState,
  cwd: string
): string

export async function fireRoutine(
  routine: Routine,
  runtime: RoutineRuntimeState,
  store: RoutineStore,
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<void>
```

---

## Phase 6 — Guard (Recursion Prevention)

**`src/guard.ts`** — prevents event hooks from forming feedback loops.

### The problem
```
user message → agent_end fires → "auto-memory" hook fires → sendUserMessage →
agent_end fires again → "auto-memory" hook fires → infinite loop
```

### Solution
Two-level guard:

**Level 1: Global flag**
```ts
runtime.isRoutineTurnActive = true  // set before sendUserMessage
                                    // reset after agent_end handler completes
```
All event hook handlers check this flag. If set: skip.

**Level 2: Input source tagging**
In the `input` event handler:
```ts
pi.on("input", (event, ctx) => {
  if (event.source === "extension" && runtime.isRoutineTurnActive) {
    // This is our own injection. Tag it.
    runtime.pendingRoutineInputId = generateId();
  }
})
```
In `agent_end`: check if the turn that just ended was tagged as a routine turn.

**Level 3: Depth limit**
Even with the guards, belt-and-suspenders: track `routineDepth`. If > 1 somehow, hard-stop.

### Edge Cases

| Case | Handling |
|------|----------|
| session_shutdown fires while routine is active | Shutdown wins. Stop everything. |
| Two routines somehow queue simultaneously | Queue is sequential. Only one isRoutineTurnActive at a time. |
| Guard stuck true (exception in sendUserMessage) | executor.ts catch block resets the flag. Also: session_start always resets it. |

---

## Phase 7 — Suppressor

**`src/suppressor.ts`** — intercepts `[~]` responses and replaces them with compact status.

### Mechanism
```ts
pi.on("message_end", (event, ctx) => {
  if (!runtime.isRoutineTurnActive) return;
  if (event.message.role !== "assistant") return;
  
  const text = extractText(event.message);
  if (!text.trimStart().startsWith(SILENT_TOKEN)) return;
  
  // Replace the assistant message content with a minimal status line
  const name = runtime.activeRoutineName ?? "routine";
  const tick = getTickState(name).tickCount;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  
  return {
    message: {
      ...event.message,
      content: [{
        type: "text",
        text: `↺ ${name} · quiet · tick ${tick} · ${time}`
      }]
    }
  };
});
```

This replaces the full response with a single minimal line in chat. The message still appears (so the turn is visible in the tree/history) but takes up minimal space.

### Footer widget update
After each suppressed tick: update the footer widget with latest status.

### Edge Cases

| Case | Handling |
|------|----------|
| LLM outputs `[~]` followed by text | Only suppress if `[~]` is the entire meaningful content (trim + startsWith check). If there's more text after, don't suppress — LLM decided it has something to say |
| `quiet: false` routine | Never check for `[~]`, pass through message_end untouched |
| message_end fires for non-assistant message (tool result, etc.) | Guard: only apply to `role === "assistant"` messages |
| `extractText` fails (message has no text blocks) | Return undefined (no modification) |

```ts
export function registerSuppressor(
  pi: ExtensionAPI,
  runtime: RoutineRuntimeState
): void

function extractText(message: AgentMessage): string
// Gets text content from message, returns "" if none
```

---

## Phase 8 — Widget

**`src/widget.ts`** — footer status showing active routines.

### Display
```
↺ 3 active  ci-watch(q·8) · pomodoro(12m) · test-guardian(3m)  [i to expand]
```

Where:
- `(q·8)` = quiet mode, 8 silent ticks
- `(12m)` = 12 minutes until next fire
- Numbers are approximate (update every 10s, not every second)

### Implementation
Use `ctx.ui.setStatus("routines", text)` for a non-intrusive footer addition.
This integrates with the existing footer without replacing it (unlike `setFooter`).
Simpler and safer than a custom footer component.

### Update frequency
- Update on every routine fire (immediate state change)
- Update on routine create/delete
- Refresh time-remaining every 10 seconds via a separate lightweight interval
- Stop refreshing when no pulse routines are active

### Edge Cases

| Case | Handling |
|------|----------|
| No active routines | Clear the status: `setStatus("routines", undefined)` |
| `ctx.hasUI` is false (print mode) | Skip widget entirely |
| Very long routine names | Truncate to 12 chars in status display |
| Widget update interval + session_shutdown | Clear widget interval in session_shutdown handler |

---

## Phase 9 — Event Hooks

**`src/hooks.ts`** — handlers for session_start, agent_end, session_shutdown.

### `session_start`
```ts
pi.on("session_start", async (event, ctx) => {
  // 1. Reset recursion guard (critical: clears any stuck state from last session)
  runtime.isRoutineTurnActive = false;
  runtime.activeRoutineName = null;
  
  // 2. Load store from disk
  runtime.store = await loadStore();
  
  // 3. Start schedulers for all pulse routines
  for (const routine of getPulseRoutines(runtime.store)) {
    scheduleRoutine(routine, runtime, pi, () => runtime.lastUiCtx);
  }
  
  // 4. Fire session_start hooks (with once-daily guard)
  const startHooks = getHookRoutines(runtime.store, "session_start");
  for (const hook of startHooks) {
    if (shouldFireHook(hook, runtime.store.tickState[hook.id])) {
      await fireRoutine(hook, runtime, runtime.store, pi, ctx);
    }
  }
  
  // 5. Update widget
  runtime.lastUiCtx = ctx;
  updateWidget(runtime, ctx);
});
```

**Once-daily guard for session_start hooks:**
```ts
function shouldFireHook(routine: Routine, tickState?: RoutineTickState): boolean {
  const trigger = routine.trigger as HookTrigger;
  if (trigger.once === "daily") {
    const today = new Date().toLocaleDateString("en-CA"); // "2026-05-19"
    return tickState?.lastFiredDateLocal !== today;
  }
  if (trigger.once === "per_session") {
    // Only fire on "startup", not on reload/fork/resume
    // Use session_start reason to decide
    return true; // checked in handler via event.reason
  }
  return true; // no guard, always fire
}
```

For `once: "per_session"`, only fire when `event.reason === "startup"`. Skip on `"reload"`, `"fork"`, `"resume"`.

### `agent_end`
```ts
pi.on("agent_end", async (event, ctx) => {
  // 1. Reset recursion guard IF this was our routine turn
  const wasRoutineTurn = runtime.isRoutineTurnActive;
  if (wasRoutineTurn) {
    runtime.isRoutineTurnActive = false;
    runtime.activeRoutineName = null;
  }
  
  // 2. Drain the queue (LLM is now idle)
  drainQueue(runtime, pi, () => ctx);
  
  // 3. Fire agent_end hooks ONLY if this was NOT a routine turn
  if (!wasRoutineTurn) {
    const endHooks = getHookRoutines(runtime.store, "agent_end");
    for (const hook of endHooks) {
      if (shouldFireHook(hook, runtime.store.tickState[hook.id])) {
        await fireRoutine(hook, runtime, runtime.store, pi, ctx);
        break; // only fire one agent_end hook per turn to avoid stacking
      }
    }
  }
  
  runtime.lastUiCtx = ctx;
  updateWidget(runtime, ctx);
});
```

**Note**: `break` after first agent_end hook. Multiple agent_end hooks could stack and each would trigger another agent_end. One per turn is safe; more requires careful ordering.

For v1: only allow one agent_end hook to be registered. Enforce this in RoutineCreate: reject if a second agent_end hook is attempted.

### `session_shutdown`
```ts
pi.on("session_shutdown", async (event, ctx) => {
  // 1. Stop all timers immediately
  stopScheduler(runtime);
  
  // 2. Clear queue
  runtime.queue = [];
  
  // 3. Fire session_shutdown hooks (before we stop)
  // BUT: only if not already in a routine turn (avoid partial state)
  if (!runtime.isRoutineTurnActive) {
    const shutdownHooks = getHookRoutines(runtime.store, "session_shutdown");
    for (const hook of shutdownHooks) {
      await fireRoutine(hook, runtime, runtime.store, pi, ctx);
    }
  }
  
  // 4. Save store
  await saveStore(runtime.store);
  
  // 5. Clear widget
  if (ctx.hasUI) ctx.ui.setStatus("routines", undefined);
  
  // 6. Reset guard
  runtime.isRoutineTurnActive = false;
});
```

**Edge case**: `session_shutdown` with `reason: "reload"` — don't fire shutdown hooks on reload.
Only fire `session_shutdown` hooks when `reason === "quit"`.

---

## Phase 10 — Tools

### `RoutineCreate`

**Schema:**
```ts
Type.Object({
  name: Type.String({
    description: "Short identifier, lowercase with hyphens. Used in /routine-stop."
  }),
  prompt: Type.String({
    description: "What to ask Pi on each tick. For quiet routines, end with instructions to output [~] if nothing changed."
  }),
  trigger: Type.Union([
    Type.Object({
      kind: Type.Literal("pulse"),
      interval: Type.String({ description: "e.g. '5m', '1h', '30s'" })
    }),
    Type.Object({
      kind: Type.Literal("hook"),
      event: Type.Union([
        Type.Literal("session_start"),
        Type.Literal("agent_end"),
        Type.Literal("session_shutdown"),
      ]),
      once: Type.Optional(Type.Union([
        Type.Literal("daily"),
        Type.Literal("per_session"),
      ]))
    })
  ]),
  quiet: Type.Optional(Type.Boolean({
    description: "Suppress [~] responses from chat (show only in footer). Default: false."
  })),
  maxTicks: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Auto-delete after N fires. Omit for unlimited."
  }))
})
```

**Validation:**
1. `name` must be `[a-z0-9-]+`, max 32 chars
2. If `trigger.kind === "pulse"`: parse interval (may throw ParseError → return as tool error)
3. If `trigger.kind === "hook" && event === "agent_end"`: check no other agent_end hook exists
4. Max 20 active routines total (across pulse + hook)
5. If name already exists: update the existing routine (upsert semantics)

**On success:**
- Add to store
- If pulse: call `scheduleRoutine()`
- Save store
- Update widget
- Return: `{ id, name, trigger, nextFireIn?: "5m 0s" }`

**Tool result message:**
```
Created pulse routine "ci-watch" — fires every 5m.
Next fire in ~5m. Use /routine-stop ci-watch to cancel.
```

### `RoutineList`

**Schema:** `Type.Object({})` (no params)

**Returns:**
```ts
{
  routines: Array<{
    id: string;
    name: string;
    triggerDescription: string;  // "every 5m" or "on session_start (daily)"
    tickCount: number;
    lastFiredAt: string;         // "2 minutes ago" or "never"
    quiet: boolean;
    maxTicks?: number;
  }>
}
```

**Tool result message:** Formatted table or "No routines active."

### `RoutineDelete`

**Schema:**
```ts
Type.Object({
  id: Type.Optional(Type.String({ description: "Routine ID" })),
  name: Type.Optional(Type.String({ description: "Routine name" })),
})
// at least one of id or name required — validated in execute()
```

**On execute:**
1. Resolve by id or name (name lookup: case-insensitive)
2. `unscheduleRoutine()` if pulse
3. Remove from store
4. Save store
5. Update widget

**Edge cases:**
- Neither id nor name provided: return error
- Not found: return error with helpful message listing current routines
- Name matches multiple (shouldn't happen, names are unique): delete first match, warn

### `RoutineSetState`

**Schema:**
```ts
Type.Object({
  id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  state: Type.Record(Type.String(), Type.Unknown(), {
    description: "Arbitrary JSON object. Merged into existing state (not replaced)."
  })
})
```

**Purpose:** LLM can persist state between ticks. E.g., CI watcher stores `{ lastStatus: "passing" }`.

**Behavior:** Deep merge into `tickState[id].userState`, not full replace.

**Validation:**
- Resolved routine must exist
- `JSON.stringify(mergedState).length` must be < MAX_USER_STATE_BYTES (2KB)
- If too large: return error with current size and limit

**Security note:** The `state` object is injected back into the prompt verbatim. No code execution. But malformed values could clutter context. Size limit mitigates this.

---

## Phase 11 — Slash Commands

### `/routine <interval> <prompt>`
Shortcut for RoutineCreate (pulse). Auto-names based on first 3 words of prompt.

```
/routine 5m check if CI is passing
→ RoutineCreate({ name: "check-if-ci", trigger: { kind: "pulse", interval: "5m" }, prompt: "check if CI is passing", quiet: false })
```

**Parsing:** Everything up to and including the first token that matches `parseInterval()` is the interval. Everything after is the prompt. If parsing fails: show error with examples.

**Auto-name collision:** Append `-2`, `-3` etc.

### `/routine-on <event> <prompt>`
Shortcut for RoutineCreate (hook).

```
/routine-on session_start summarize my git log since yesterday
/routine-on agent_end if a decision was made, save it to engram
```

Accepts: `session_start`, `agent_end`, `session_shutdown` (and aliases: `start`, `end`, `stop`).

### `/routines`
Lists all active routines with status. Calls RoutineList internally.
Output format:
```
Active routines (3):
  ci-watch      · pulse · every 5m · tick 8 · quiet · next: 3m 14s
  morning-brief · hook  · session_start (daily) · fired today at 09:02
  pomodoro      · pulse · every 25m · tick 2 · next: 18m 32s
```

### `/routine-stop <id|name>`
Calls RoutineDelete. Tab-completion on known routine names.

```ts
getArgumentCompletions: (prefix) => {
  return Object.values(runtime.store.routines)
    .filter(r => r.name.startsWith(prefix))
    .map(r => ({ label: r.name, description: r.trigger.kind }));
}
```

### `/routine-install <template>`
Installs a built-in template.

1. Read `templates/<name>.json`
2. Check `requiredTools` — for each, run `which <tool>`. If missing: warn (don't block).
3. Call RoutineCreate with template values
4. Confirm: "Installed ci-watch — fires every 3m. Start with: /routines"

Tab-completion on template names.

```
/routine-install ci-watch
/routine-install morning-briefing
/routine-install pomodoro
```

### `/routine-export-cron <name>`
Prints crontab/launchd instructions for persistent execution.

Output:
```
# To run "morning-briefing" even when Pi is closed:
# 
# 1. Create the prompt file:
cat > ~/.pi/routines/prompts/morning-briefing.txt << 'EOF'
[prompt text here]
EOF

# 2. Add to crontab (crontab -e):
0 9 * * 1-5 /usr/local/bin/pi --print "$(cat ~/.pi/routines/prompts/morning-briefing.txt)" \
  >> ~/.pi/routines/logs/morning-briefing-$(date +\%Y-\%m-\%d).log 2>&1

# Or for launchd, see: ~/.pi/routines/launchd/morning-briefing.plist
# (generated file shown below)
```

Also writes the `.plist` file to `~/.pi/routines/launchd/` for immediate use.

---

## Phase 12 — Templates

Each template is a `RoutineTemplate` JSON. Install via `/routine-install`.

### `ci-watch.json`
```json
{
  "name": "ci-watch",
  "description": "Check CI status every 3 minutes, alert on change",
  "trigger": { "kind": "pulse", "interval": "3m" },
  "prompt": "Check the CI status for the current git branch. Use `git branch --show-current` to get the branch name, then check CI (via gh, curl, or whatever CI tool is available). Only report if the status changed from last time. If nothing changed, output [~].\n\nPrevious state: {state}",
  "quiet": true,
  "requiredTools": ["gh"]
}
```

### `morning-briefing.json`
```json
{
  "name": "morning-briefing",
  "description": "Git log summary at session start, once per day",
  "trigger": { "kind": "hook", "event": "session_start", "once": "daily" },
  "prompt": "It's {time} on {date}. Give me a morning briefing:\n1. Run `git log --oneline --since='yesterday 6pm' --author=$(git config user.email) 2>/dev/null | head -20` and summarize what I worked on.\n2. Check if there's a todo.md, TASKS.md, or similar in the current directory. If so, note anything marked urgent or in-progress.\n3. Three bullets: what I shipped yesterday, what's in flight, suggested first task today.\nBe concise. If git log is empty, say so briefly.",
  "quiet": false
}
```

### `pomodoro.json`
```json
{
  "name": "pomodoro",
  "description": "25-minute focus check-in",
  "trigger": { "kind": "pulse", "interval": "25m" },
  "prompt": "Pomodoro check-in (tick #{tickCount}).\nLook at our conversation so far this session. In 2-3 sentences:\n1. Did I make progress toward what I was trying to do?\n2. Am I in a rabbit hole that's blocking forward progress?\n3. Suggested focus for the next 25 minutes.\nBe direct. No fluff.",
  "quiet": false,
  "maxTicks": 8
}
```

### `deploy-watch.json`
```json
{
  "name": "deploy-watch",
  "description": "Check deploy status every 2m, self-terminates when done",
  "trigger": { "kind": "pulse", "interval": "2m" },
  "prompt": "Check deployment status. Run any available deploy status command (kubectl rollout status, railway status, fly status, heroku releases, etc. — try what's available). \n\nPrevious state: {state}\n\nIf deployment is complete or failed: summarize the result, then call RoutineDelete with name='deploy-watch' to stop checking.\nIf still in progress: update state with current status via RoutineSetState, then output [~].\nIf no deploy tool found: say so and call RoutineDelete.",
  "quiet": true
}
```

### `session-wrap.json`
```json
{
  "name": "session-wrap",
  "description": "Summarize and save session notes on shutdown",
  "trigger": { "kind": "hook", "event": "session_shutdown", "once": "per_session" },
  "prompt": "This session is ending. Write a brief session summary:\n1. What was accomplished (2-3 bullets)\n2. Key decisions made (if any)\n3. What's unfinished / next steps\n\nSave to Engram with title 'Session wrap {date}' and type 'learning'. If Engram is unavailable, write to ~/.pi/routines/logs/session-{date}-{time}.md instead.\n\nKeep it under 200 words.",
  "quiet": false
}
```

### `pr-babysitter.json`
```json
{
  "name": "pr-babysitter",
  "description": "Watch open PRs for new activity every 15m",
  "trigger": { "kind": "pulse", "interval": "15m" },
  "prompt": "Check open PRs for new activity. Run `gh pr list --author @me --state open --json number,title,url 2>/dev/null` to find your PRs. For each, check for new review comments or CI status changes since last check.\n\nPrevious state: {state}\n\nIf new blocking comments or CI failures: report them clearly.\nIf nothing changed: output [~].\nUpdate state with current PR statuses via RoutineSetState.",
  "quiet": true,
  "requiredTools": ["gh"]
}
```

### `test-guardian.json`
```json
{
  "name": "test-guardian",
  "description": "Re-run failing tests every 5m during TDD",
  "trigger": { "kind": "pulse", "interval": "5m" },
  "prompt": "TDD check. Run the test suite (try `pnpm test`, `npm test`, `bun test`, `pytest`, `cargo test` — use whichever matches the project). \n\nPrevious state: {state}\n\nReport only if test results changed from last tick. If tests went from failing to passing: celebrate briefly. If a new failure appeared: report the new error message. If same failures as before: output [~].\n\nUpdate state with current pass/fail counts via RoutineSetState.",
  "quiet": true
}
```

---

## Phase 13 — Extension Entry Point

**`extensions/index.ts`** — wires everything together.

```ts
export default function registerRoutinesExtension(pi: ExtensionAPI): void {
  // Hot-reload cleanup (same pattern as pi-subagents)
  const globalStore = globalThis as Record<string, unknown>;
  const CLEANUP_KEY = "__piRoutinesCleanup";
  const previousCleanup = globalStore[CLEANUP_KEY];
  if (typeof previousCleanup === "function") {
    try { previousCleanup(); } catch { /* best effort */ }
  }

  // Runtime state (single instance per extension load)
  const runtime: RoutineRuntimeState = {
    store: emptyStore(),
    timers: new Map(),
    queue: [],
    isRoutineTurnActive: false,
    activeRoutineName: null,
    lastUiCtx: null,
  };

  // Register tools
  registerRoutineCreateTool(pi, runtime);
  registerRoutineListTool(pi, runtime);
  registerRoutineDeleteTool(pi, runtime);
  registerRoutineSetStateTool(pi, runtime);

  // Register slash commands
  registerRoutineCommand(pi, runtime);
  registerRoutineOnCommand(pi, runtime);
  registerRoutinesCommand(pi, runtime);
  registerRoutineStopCommand(pi, runtime);
  registerRoutineInstallCommand(pi, runtime);
  registerRoutineExportCronCommand(pi, runtime);

  // Register event handlers
  registerHooks(pi, runtime);         // session_start, agent_end, session_shutdown
  registerSuppressor(pi, runtime);    // message_end [~] handler
  registerInputTracker(pi, runtime);  // input source tagging for recursion guard

  // Cleanup on reload/shutdown
  const cleanup = () => {
    stopScheduler(runtime);
    if (runtime.lastUiCtx?.hasUI) {
      runtime.lastUiCtx.ui.setStatus("routines", undefined);
    }
  };
  globalStore[CLEANUP_KEY] = cleanup;
}
```

---

## Edge Case Matrix

Critical edge cases that span multiple components:

### 1. Extension hot-reload (`/reload`)
- `session_shutdown` fires with `reason: "reload"`
- Cleanup runs: timers cleared, queue cleared
- Store is saved to disk
- New extension instance loads
- `session_start` fires with `reason: "reload"`
- Routines re-initialized from disk
- ✅ No orphan timers. No lost routines.

### 2. Routine fires mid-LLM stream
- Timer tick fires → `drainQueue()` called
- `ctx.isIdle()` returns false (LLM streaming)
- Routine pushed to queue (if not already there — dedup by id)
- Queue drained on next `agent_end` event
- ✅ No interruption of current turn.

### 3. Multiple sessions open simultaneously
- Each Pi session is a separate process with its own extension instance
- Each has its own `runtime` in memory
- Both load from the same `state.json` on `session_start`
- Last-write-wins on save (atomic rename)
- In practice: in-session routines are session-local (pulse timers only exist in-process)
- v1 doesn't try to coordinate between sessions
- ✅ Acceptable for v1. Note in docs.

### 4. Routine with `maxTicks: 1` (one-shot)
- `fireRoutine()` checks `tickState.tickCount >= routine.maxTicks` BEFORE firing
- If limit reached: calls RoutineDelete internally, skips fire
- Edge: tickCount incremented on fire. Check is `tickCount >= maxTicks` not `> maxTicks`.
- ✅ Fires exactly maxTicks times, then deletes itself.

### 5. `deploy-watch` self-deletion via RoutineDelete tool call
- LLM response includes a RoutineDelete tool call
- This is a normal LLM tool call in the routine's response turn
- The tool call fires normally (RoutineDelete removes the routine from store + timer)
- The recursion guard prevents agent_end from firing new routines after this turn
- ✅ Clean self-termination.

### 6. Session_shutdown fires with shutdown hooks AND pending queue
- `session_shutdown` handler: first `stopScheduler()` and clear queue
- Then fire shutdown hooks
- The shutdown hook fires as the last action
- If shutdown hook itself tries to queue something: queue is cleared, no-op
- ✅ Shutdown hooks fire once, nothing queued after.

### 7. `once: "daily"` routine when clock is wrong or timezone changes
- `lastFiredDateLocal` uses `new Date().toLocaleDateString("en-CA")` → ISO format "2026-05-19"
- If timezone changes: date string changes → guard doesn't match → fires again
- Acceptable: edge case, not worth complex timezone tracking
- ✅ Works correctly in the 99.9% case.

### 8. State file corruption between sessions
- Load: wrapped in try/catch. On any parse error → `emptyStore()`
- Active routines are lost
- User sees: no routines on next session_start
- Mitigation: write a `.bak` file on each successful save (write `.bak` first, then `.json`)
- Recovery: `cp state.json.bak state.json`
- ✅ Graceful degradation. Data not lost if `.bak` is present.

### 9. Pi `--print` mode (headless, no UI)
- `ctx.hasUI === false`
- Skip all widget updates (`setStatus`)
- Skip session_start hooks (no interactive session)
- Pulse routines: don't start timers (print mode exits after one turn)
- ✅ Extension is a no-op in print mode except for tools exposed to LLM.

---

## Settings Schema

Extension config at `~/.pi/agent/extensions/routines/config.json`:

```ts
interface RoutinesConfig {
  maxRoutines?: number;       // default: 20
  maxQueueDepth?: number;     // default: 3
  minIntervalMs?: number;     // default: 30_000 (30s)
  disableInPrintMode?: boolean; // default: true
}
```

---

## Build + Install

**`package.json` (key fields):**
```json
{
  "name": "pi-routines",
  "version": "0.1.0",
  "type": "module",
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "dependencies": {
    "typebox": "^1.0.0"
  }
}
```

**Add to `~/.pi/agent/settings.json`:**
```json
{
  "extensions": [
    "~/.pi/agent/extensions/pi-routines"
  ]
}
```

Or publish to npm and install via:
```json
{
  "packages": ["npm:pi-routines"]
}
```

---

## Implementation Order

```
Phase 1  → types.ts              (no deps, everything imports from here)
Phase 2  → store.ts              (deps: types)
Phase 3  → parser.ts             (deps: types)
Phase 4  → guard.ts              (deps: types)
Phase 5  → executor.ts           (deps: types, store, parser)
Phase 6  → scheduler.ts          (deps: types, executor, guard)
Phase 7  → suppressor.ts         (deps: types)
Phase 8  → widget.ts             (deps: types)
Phase 9  → hooks.ts              (deps: types, store, scheduler, executor, guard)
Phase 10 → tools/*.ts            (deps: types, store, scheduler, parser)
Phase 11 → commands/*.ts         (deps: types, store, scheduler, tools, parser)
Phase 12 → templates/*.json      (no deps, static data)
Phase 13 → extensions/index.ts   (deps: everything)
```

**Each phase is independently testable before moving on.**

The first testable slice (phases 1–7 + index.ts stub) gives you:
- RoutineCreate / RoutineDelete / RoutineList working
- `/routine 5m check build` working
- Pulse routines firing and suppressing `[~]`
- Hot-reload safe

Templates and remaining commands can follow without touching core logic.
