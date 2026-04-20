---
name: ABAP Code Review
description: Structured checklist for reviewing ABAP objects (classes, programs, function modules) for clean code, performance, and maintainability. Applies to classic and Cloud ABAP.
version: 1.0.0
tags: [sap, abap, code-review, clean-code, performance]
---

# ABAP Code Review — Skill Reference

## Scope

This skill governs how the agent reviews an ABAP object fetched via MCP tools. It applies when the user asks to "review", "audit", "assess quality of" an ABAP object.

## Hallucination Detection

Before producing any finding, the agent MUST have called `GetClass`, `GetProgram`, or `GetInclude` in the current session. Indicators of fake reviews:

- Findings quote code that does not appear in the fetched source.
- Line numbers do not exist in the object.
- Generic advice ("consider using OOP") with no object-specific reference.

**Rule:** every finding must cite object name + line number and quote ≤3 lines of the actual source.

## Review Order

Process objects in this order, stop at first blocker:

1. **Header** — documentation, author, last-change.
2. **Public interface** — method names, parameter types, return values.
3. **Internal logic** — control flow, SELECTs, loops.
4. **Error handling** — exceptions, MESSAGE statements.
5. **Performance-critical sections** — loops with SELECTs, missing WHERE, SORT before READ BINARY.
6. **Security** — dynamic SQL, AUTHORITY-CHECK (delegated to `security-scan` skill if in scope).

## Checklist

### Naming
- Classes start with `ZCL_` / `ZIF_`; customer namespace respected.
- Method names are verbs (`get_customer`, `calculate_total`), not nouns.
- Variables have type prefixes only where project convention requires — do not invent.

### Clean ABAP
- No `INCLUDE` inside classes (except test includes).
- No `FORM`/`PERFORM` in new code — flag but do not rewrite unless asked.
- `DATA`/`TYPES` declared at narrowest scope possible.
- Inline declarations (`DATA(...)`) preferred over up-front `DATA:`.
- String templates (`|{ ... }|`) preferred over `CONCATENATE`.
- Avoid `CHECK` as early-return in methods — use `RETURN` or `RAISE EXCEPTION`.

### Performance
- **Red flag:** `SELECT` inside `LOOP AT` — suggest `SELECT ... FOR ALL ENTRIES` or JOIN in CDS.
- **Red flag:** `SELECT *` when the consumer uses 2–3 fields.
- **Red flag:** `SORT itab.` without field list before `READ TABLE ... BINARY SEARCH`.
- **Red flag:** `APPEND` to standard table followed by `READ ... WITH KEY` — suggest hashed/sorted table.
- **Red flag:** missing `WHERE` on large transactional tables (VBAP, BSEG, MSEG, MARC).

### Error Handling
- Public methods declare `RAISING` explicitly — avoid `RAISING cx_root`.
- Exceptions carry context: original message, relevant identifiers.
- `TRY ... CATCH cx_root` at top level is acceptable as a backstop; in business logic it hides bugs.

### Testing
- Classes have a counterpart test class (`ZCL_FOO` → `ZCL_FOO_TEST` or local `ltcl_*`).
- If no tests exist: flag as finding, do not invent test stubs unless asked.

### Maintainability
- Methods ≤ 50 statements. Longer methods flagged with specific line ranges to extract.
- Cyclomatic complexity > 10 flagged.
- Duplicate blocks (≥ 5 identical lines in 2+ places) flagged.
- TODO/FIXME/HACK comments surfaced with author + date if available from version.

## Output Format

```markdown
# Review: <OBJECT_NAME>

## Summary
<2-3 sentences: overall health, top issues>

## Findings

### [Severity] <Short title>
- **Location:** <object>, line <N>
- **Snippet:**
  ```abap
  <≤3 lines of actual source>
  ```
- **Why it matters:** <concrete impact>
- **Suggested change:** <minimal diff>

(repeat per finding; group by severity: Blocker / Major / Minor / Info)

## Not Reviewed
<list of things skipped and why — e.g., "test class not found, skipped test coverage review">
```

## Non-Goals

- Do NOT rewrite the object unless explicitly asked.
- Do NOT propose refactorings spanning multiple objects — stick to the object under review.
- Do NOT invent line numbers or fields.

## Common Failures

| Symptom | Remedy |
|---------|--------|
| Finding without line number | Reject. Ask the agent to re-read the object. |
| "Consider using OOP" with no example | Reject — not actionable. |
| Generic performance advice | Require a SELECT/LOOP citation. |
| Every method marked "too long" | Require cyclomatic complexity reasoning, not just line count. |
