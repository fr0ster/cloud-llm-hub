---
name: security-review
description: Stage 2 of code review — security check (authority, secrets, injection)
---

# security-review

Stage-2 skill. One ABAP target → security findings.

## Goal

Find issues that could lead to a breach, privilege escalation, or credential leak. Reject anything that's just a style problem — that belongs in maintainability.

## Rule set

- **Hardcoded credentials / secrets / hosts / paths that should be configurable.** CRITICAL if a real secret value is in source; HIGH if a production host or path is hardcoded.
- **Missing or weak `AUTHORITY-CHECK`** before sensitive operations: file write, transport ops, `SXPG_COMMAND_EXECUTE`, `CALL FUNCTION` for cross-system RFC, table maintenance.
- **Dynamic SQL via concatenation** — building a SELECT/UPDATE/DELETE string from user- or row-controlled values then executing via `EXEC SQL`, native SQL, or `WHERE` built with templates. SQL/ABAP injection risk. HIGH unless input is provably constrained.
- **Shell-injection risk** from `SXPG_COMMAND_EXECUTE` `additional_parameters` built via concatenation without escaping. HIGH.
- **Sensitive data written to dev_w / syslog / WRITE output** — PASSPHRASE, PRIVATE_KEY_PATH content, full credential strings echoed in error messages.
- **Plaintext password storage** in `zfi_constants` or similar — if `FTP_PSWD` is stored as plain `FVAL`, flag as HIGH.
- **Missing input validation** on user-controlled PARAMETERS before sensitive use.

## Prompt pattern

Runs **after** Stage 0 ([abap-read-source](abap-read-source.md)) has loaded the full source into the chat session. Do NOT bundle the read procedure into this prompt — under the weight of the rule set the model skips the read step and invents findings from training-data ABAP. Key elements:

1. Confirm assumption: "Assume the full source (main + every include) is already in this chat session from Stage 0. If it is not, stop and ask the user to run the read step first."
2. Apply ONLY security rules. Reject findings that belong in other categories.
3. Output strict per-finding shape: `SEVERITY — Title / Location / Snippet / Why / Recommendation`.
4. Require source citation; no source = no finding.

See `examples/ZDEMO_REPORT/curl/req-security.json` (local, gitignored) for a worked prompt example.

## Severity ladder for this category

- CRITICAL — real secret leaked, exploitable injection with clear data path.
- HIGH — missing AUTHORITY-CHECK on sensitive op, plausible injection vector, plaintext credential storage.
- MEDIUM — defensive concern (credential string concatenated into a variable that *could* be logged).
- LOW — style / habit issue (hardcoded separator characters, magic strings).

## Worked example

`examples/ZDEMO_REPORT/02-security.md` — 4 findings (2 HIGH, 1 MEDIUM, 1 LOW).

## Related

- `cleancore-review.md` — sibling skill. SXPG_COMMAND_EXECUTE is *also* a CleanCore issue; rule of thumb: security asks "is the call safe?", CleanCore asks "is the call allowed in S/4HANA Cloud?".
- `aggregation.md` — Stage 6.
