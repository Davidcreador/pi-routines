# Task: TP-004 — Templates & Skill

**Created:** 2026-05-19
**Size:** S

## Review Level: 0 (None)

**Assessment:** Static JSON template authoring plus a SKILL.md. No executable
logic, no behavior change in the binary path. Schema is validated at install
time by TP-007. Trivial to revise.

**Score:** 0/8 — Blast radius: 0 (data only), Pattern novelty: 0, Security: 0,
Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-004-templates-skill/
├── PROMPT.md
├── STATUS.md
├── .reviews/
└── .DONE
```

## Mission

Create the 7 built-in routine templates exactly as specified in `PLAN.md`
Phase 12, plus a `SKILL.md` that documents the slash-command surface for LLMs.
These are the headline value-driver for adoption — every user gets working
routines in 30 seconds.

## Dependencies

- **Task:** TP-001 (the `RoutineTemplate` type is the schema these JSON files conform to)

## Context to Read First

**Tier 2:**
- `taskplane-tasks/CONTEXT.md`

**Tier 3:**
- `PLAN.md` — Phase 12 (Templates) for the exact JSON, and the use-case
  framing from earlier sections
- `src/types.ts` — the `RoutineTemplate` shape these JSONs must satisfy

## Environment

- **Workspace:** `/Users/davecodes/work/pi-routines`

## File Scope

- `templates/ci-watch.json` (new)
- `templates/morning-briefing.json` (new)
- `templates/pomodoro.json` (new)
- `templates/deploy-watch.json` (new)
- `templates/session-wrap.json` (new)
- `templates/pr-babysitter.json` (new)
- `templates/test-guardian.json` (new)
- `skills/routine/SKILL.md` (new)

## Steps

### Step 0: Preflight

- [ ] TP-001 complete; `src/types.ts` exports `RoutineTemplate`
- [ ] `templates/` and `skills/routine/` directories created

### Step 1: Author 7 templates

Copy the JSON blocks from `PLAN.md` Phase 12 verbatim, then:

- [ ] Verify each JSON parses (`node -e "JSON.parse(require('fs').readFileSync('templates/<name>.json','utf8'))"`)
- [ ] Verify each conforms to the `RoutineTemplate` shape (visual check — TP-007's
  install command will do strict validation later)
- [ ] Replace any `{state}`, `{date}`, `{time}`, `{tickCount}`, `{cwd}` placeholders
  in the prompt strings as designed — the executor substitutes them at fire time
- [ ] For templates that list `requiredTools` (`ci-watch`, `pr-babysitter`), the
  array values are exactly the binary names tested via `which <name>`

**Files (one each):**

- `templates/ci-watch.json` — pulse 3m, quiet, requires `gh`
- `templates/morning-briefing.json` — hook `session_start`, once: daily
- `templates/pomodoro.json` — pulse 25m, maxTicks: 8
- `templates/deploy-watch.json` — pulse 2m, quiet, self-terminates
- `templates/session-wrap.json` — hook `session_shutdown`, once: per_session
- `templates/pr-babysitter.json` — pulse 15m, quiet, requires `gh`
- `templates/test-guardian.json` — pulse 5m, quiet

**Artifacts:**
- Seven JSON files under `templates/`

### Step 2: Write `skills/routine/SKILL.md`

This is the routine-management skill an LLM loads when the user wants to work
with routines. Format:

```markdown
---
name: routine
version: 0.1.0
description: Manage pi-routines — create, list, stop, install templates. Use when the user wants to schedule recurring AI prompts, install monitoring routines, set up morning briefings, or build event-driven hooks (session_start, agent_end, session_shutdown).
---

# Routine

[Body: how to use RoutineCreate, RoutineList, RoutineDelete, RoutineSetState
tools, when to use slash commands instead, how to install a template, when to
recommend a quiet routine vs verbose, etc.]
```

- [ ] Front-matter with searchable `description` covering verbs users say
  ("recurring", "schedule", "monitor", "background check", "morning briefing",
  "pomodoro", "CI watch")
- [ ] Section: **When to use each tool vs slash command**
- [ ] Section: **Choosing pulse vs hook**
- [ ] Section: **Quiet vs verbose** — when to set `quiet: true` (default no)
- [ ] Section: **Built-in templates** — list each by name and one-line
  description, with the `/routine-install <name>` command
- [ ] Section: **Self-terminating routines** — pattern (deploy-watch is the
  canonical example: routine prompt instructs the LLM to call `RoutineDelete`
  when its completion condition is met)
- [ ] Section: **Common pitfalls** — `[~]` only works for `quiet: true`,
  minimum interval is 30s, max 20 active routines, etc.
- [ ] Keep total length under 200 lines. The skill is meta-documentation, not
  a tutorial.

**Artifacts:**
- `skills/routine/SKILL.md` (new)

### Step 3: Testing & Verification

> ZERO failures allowed.

- [ ] All 7 JSON files parse without error (loop over them with `node -e`)
- [ ] `pnpm typecheck` still passes (no source files were modified)
- [ ] `SKILL.md` front-matter is valid YAML and the body uses standard markdown

### Step 4: Documentation & Delivery

- [ ] Add a short note to `taskplane-tasks/CONTEXT.md` Discoveries listing
  the 7 template names and which require external tools (`gh`)
- [ ] If any template prompt was tweaked from PLAN.md (e.g., to clarify the
  state-injection format), log the exact change as an Amendment in this PROMPT.md

## Documentation Requirements

**Must Update:**
- `taskplane-tasks/CONTEXT.md` — Discoveries (template list + tool requirements)

**Check If Affected:**
- `PLAN.md` — do not modify; record any improvements as Amendments

## Completion Criteria

- [ ] All 7 template JSON files exist and parse
- [ ] `skills/routine/SKILL.md` exists with proper front-matter
- [ ] No source code touched (`src/` is unchanged)

## Git Commit Convention

- **Step completion:** `feat(TP-004): complete Step N — description`
- **Bug fixes:** `fix(TP-004): description`

## Do NOT

- Write any TypeScript or JavaScript — this task is data + markdown only
- Modify `src/types.ts` — if the schema needs adjustment, file an Amendment
  to TP-001 and use the current shape in the meantime
- Add new templates beyond the 7 specified; user-extensibility comes from
  `RoutineCreate`, not from shipping more built-ins in v1
- Change `requiredTools` semantics — the install command treats them as warnings, not blockers

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues are discovered during execution. -->
