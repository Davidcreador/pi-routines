## Plan Review: Step 4 — src/store.ts atomic persistence

### Verdict: APPROVE

### Summary
Outcome-level checkboxes fully cover PLAN.md Phase 2 plus the additional `.bak`
disaster-recovery requirement. All edge cases from the Phase 2 matrix (missing
file, corrupt JSON, disk full, HOME unset) are explicitly enumerated. Types
(`RoutineStore`, `STATE_FILE`) are already in place from Step 2, so the
contract surface is unambiguous.

### Issues Found
None blocking.

### Suggestions
- `STATE_FILE` is resolved once at module load in `types.ts`. If a test ever
  wants to override `HOME`, the constant is frozen — fine for v1 but worth a
  mental note when writing tests later.
- Consider `fs.writeFile(tmp, ...)` followed by `fs.rename(tmp, final)` and
  then a separate `fs.copyFile(final, final + '.bak')` so a failed `.bak`
  write never compromises the primary file. Implementation detail; trust
  worker to handle.
- On corrupt-JSON recovery, consider moving the corrupt file aside (e.g. to
  `state.json.corrupt-<ts>`) before returning the empty store, so the user
  can inspect it. Not required by PROMPT — optional.

