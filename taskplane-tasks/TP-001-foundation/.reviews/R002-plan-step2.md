## Plan Review: Step 2 — `src/types.ts` single source of truth

### Verdict: APPROVE

### Summary
Step 2 spec mirrors PLAN.md Phase 1 faithfully and lists every exported type, constant, and JSDoc requirement downstream tasks will consume. Scope is appropriately narrow (types + constants only — no logic) and outcomes are clear. Safe to proceed.

### Issues Found
*None blocking.*

### Suggestions
- **`verbatimModuleSyntax: true` interaction.** tsconfig (Step 1) enables `verbatimModuleSyntax`. Worker must use `export type` for type-only exports and `import type { ExtensionContext }` style for the `lastUiCtx` field. Not a plan defect — flagging so it doesn't surface as a typecheck failure mid-implementation.
- **`STATE_FILE` HOME-fallback semantics.** PROMPT asks the constant itself to resolve with `/tmp` fallback when HOME is unset, while `store.ts` (Step 4) is also asked to fall back to `/tmp/pi-routines-state.json`. Recommend resolving once in `types.ts` (e.g. ``const home = process.env.HOME ?? "/tmp"; export const STATE_FILE = home === "/tmp" ? "/tmp/pi-routines-state.json" : `${home}/.pi/agent/extensions/routines/state.json`;``) so both modules read a single value. Not blocking — either layering works as long as paths agree.
- **`TEMPLATES_DIR` via `import.meta.url`.** Correct for ESM. Worth a JSDoc note that this resolves relative to the compiled-or-source location of `types.ts`, so the `templates/` directory must ship at package root (already implied by Phase 8 but easy to forget).
- **`RoutineContext = "session"` as a string-literal union of one.** Already correctly future-proofed in PLAN.md; the JSDoc should explicitly call out that `"fresh"` is reserved for v2 so reviewers of TP-002+ don't widen it casually.

### Missing Items
*None.* All twelve types, four constants, and the `ExtensionContext` typing for `lastUiCtx` are enumerated in the PROMPT checkboxes and match PLAN.md Phase 1.
