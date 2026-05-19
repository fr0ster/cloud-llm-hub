# RETRO — ZDMS_UPLOAD_FILES code-review run (2026-05-19)

## TL;DR

One ABAP target, four parallel category checks, ~5 minutes wall-clock, ~381k cloud-side LLM tokens, 30 findings (10 HIGH, 3 MEDIUM, 17 LOW, 0 CRITICAL). Tutorial pipeline validated.

## Wall-clock breakdown

| Phase | Wall-clock |
|---|---|
| Tutorial skeleton (folder, README, target file) | ~3 min |
| 4 parallel curl checks (security / performance / cleancore / maintainability) | ~45s (slowest finished at 43s) |
| Per-check artifact parse + 06-summary aggregation | <1 min |
| pptx build + PDF + PNG render | <1 min |
| **Total** | **≈ 6 min** |

Reference: comparable manual review by a senior ABAP engineer is estimated at 1–2 hours per category × 4 = 4–8 hours.

## Token accounting

### Executor side — cloud-llm-hub (SmartAgent + RAG embedder)

| Model | prompt | completion | total | requests |
|---|---|---|---|---|
| gpt-5.2 | 362,555 | 14,695 | 377,250 | 74 |
| embedder | 3,536 | 0 | 3,536 | 16 |
| **GRAND (executor)** | | | **380,786** | **90** |

### Controller side — this Claude Code session (Claude Opus 4.7)

Captured at end of the combined sFTP + code-review work, ~30% of session attributed to this code-review task by wall-clock (sFTP was the larger / longer task and gets the remaining ~70%):

| Model | input | output | cache read | cache write | session cost (combined) |
|---|---|---|---|---|---|
| `claude-opus-4-7` | 13.0k | 518.0k | 138.7M | 1.9M | $94.53 |

Approximate share for THIS code-review task: ~156k output + ~5.3k input + ~42M cache-read ≈ **$28.36**.

Splitting limitation: `/cost` is session-cumulative, not per-task. Future runs should capture `/cost` baseline before each task — see `feedback-token-accounting-both-sides` in memory.

Per-check token cost was uniform — each ran the same source-read sequence (ReadProgram + GetIncludesList + GetInclude × 1) and produced a similar-shaped output. Maintainability was the largest individual response (16 findings, 9.6k SSE bytes) but token-wise stayed in the same band as the others.

## What went well

- **Parallelism worked safely.** Four simultaneous SmartAgent calls using only light tools (`ReadProgram` / `GetIncludesList` / `GetInclude`) caused zero backend stress. Distinct from the `SearchSource` parallelism trap documented in the codebase-analysis run (`feedback_dont_overload_sap_backend.md`).
- **Per-category isolation produced clean output.** Each check stayed on its rule set; no security findings leaked into maintainability or vice versa. Severity discipline held across categories.
- **Source citation discipline held.** Every finding has `Location` + `Snippet`. The "no source = no finding" rule (baked into each prompt) eliminated speculation.

## What went off

### 1. Bash variable expansion mangled backticks in rule text

The `run-checks.sh` script built per-category rule strings as bash variables, then passed them to a Python heredoc that built JSON. The rule strings contained markdown backticks (e.g. `` `SXPG_COMMAND_EXECUTE` ``). Bash interpreted the backticks as command substitution before passing — shell tried to execute `SXPG_COMMAND_EXECUTE` as a command, emitting `command not found` warnings.

**Impact:** rule text reached the LLM with backtick content replaced by empty strings. Despite this, the checks still produced relevant findings (the LLM inferred the missing tokens from context). But the prompts were not exactly what was intended.

**Fix for next run:** build rule strings inside the Python heredoc using single-quoted Python literals, not bash double-quoted variables. Or read rule text from a separate file the Python heredoc opens.

### 2. Severity-summary regex missed maintainability

Each check was supposed to emit a `**Severity summary for this category:**` block at the end. Maintainability didn't emit one in the expected format — the regex in the aggregation Python missed it, and per-check counts had to be derived from the parsed `### N. <SEVERITY>` headings instead.

**Impact:** none for the aggregate; the count from finding headings is authoritative anyway.

**Fix for next run:** make the per-finding heading the only source of truth; drop the redundant severity summary block from the prompt.

## What this run revealed about the target

`ZDMS_UPLOAD_FILES` is a typical legacy SXPG/SM69-driven SFTP report:

- 0 CRITICAL — no immediate breach / data-loss risk surfaced.
- 10 HIGH — 6 of which are CleanCore blockers (SXPG + OPEN DATASET + DELETE DATASET).
- If the customer plans S/4HANA Cloud migration, this object cannot run as-is.
- For on-premise context, it's functional but accumulates style and structural debt across all four categories.

Migration alignment: this is exactly the same conclusion the parallel sFTP codebase-analysis run reached for the broader 18-object set — single underlying mechanism (`SXPG_COMMAND_EXECUTE` → SM69 → OS sftp), replace once across all callers. Code review confirms the per-object detail.

## Lessons for the next code-review run

1. **Build prompt strings in one language**, not via bash variables piped into Python. Use a single Python script that owns both rule text and JSON serialization.
2. **Severity from headings only.** Don't ask for a redundant summary block; parse the per-finding `### N. <SEVERITY>` lines.
3. **Per-check parallelism is safe for read-only tools.** Anything that includes `SearchSource` switches back to sequential.
4. **One worked example is enough.** Aggregating 30 findings across 4 categories on one program produced a complete tutorial picture. No need to fan out to all 19 SFTP-using objects — pipeline mechanics don't change with more targets.

## Open items

- Re-run on a different program (e.g. `ZSFTP_BNP_PARIBAS` which has the password-only auth pattern) to verify the security check catches credential-storage findings unique to that pattern.
- Consider adding a 5th category — "test coverage" — once the customer adopts ABAP unit tests. For now, no unit tests exist, so the category would always be empty.
- Tutorial mentions `aggregation.md` skill but the worked example does aggregation inline via Python. Document the script approach as the standard.
