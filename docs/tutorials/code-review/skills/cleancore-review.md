---
name: cleancore-review
description: Stage 4 of code review — S/4HANA CleanCore compliance check
---

# cleancore-review

Stage-4 skill. One ABAP target → CleanCore compliance findings.

## Goal

Find code that blocks S/4HANA Cloud / CleanCore — non-released APIs, OS shell access, AL11 file ops, modifications to standard, anything outside the cloud-released allow-list.

CleanCore findings default to **HIGH** because they block a migration path, even when the code works on-premise.

## Rule set

- **`SXPG_COMMAND_EXECUTE`** — OS shell access via SM69. Not in the cloud-released set. HIGH.
- **`OPEN DATASET` / `READ DATASET` / `TRANSFER` / `CLOSE DATASET` / `DELETE DATASET`** on AL11-style paths — application-server file I/O. Not allowed in S/4HANA Cloud. HIGH.
- **Direct DDIC access** to standard SAP tables that have a released API alternative. HIGH.
- **Modifications to SAP standard objects** (any `*_MODI` marker, MODIFICATION-INCLUDE blocks). HIGH.
- **Calls to function modules / classes not on the cloud-released allow-list** — anything outside released `SAP_*` API set. HIGH unless explicitly released.
- **`CALL TRANSACTION`** to non-released transactions. HIGH.
- **Direct table buffer access**, `COMMIT WORK` in user exits, raw kernel calls. HIGH.
- **Submission to background via `SUBMIT ... VIA JOB`** to non-released programs. MEDIUM/HIGH depending on the target.
- **Use of obsolete or non-cloud-released language constructs** (e.g. `EXEC SQL` for direct native SQL, `EDITOR-CALL`, dialog primitives outside SAPUI5). HIGH.

## Severity policy

- HIGH default — anything that blocks running this code in S/4HANA Cloud.
- INFO — note when a pattern is allowed on-premise and would only be problematic in a future Cloud migration that hasn't been committed to.
- Do not emit MEDIUM/LOW here unless the issue is genuinely a *partial* CleanCore concern (rare).

## Prompt pattern

Same shape as the other check skills. See `examples/ZDEMO_REPORT/curl/req-cleancore.json`.

## Worked example

`examples/ZDEMO_REPORT/04-cleancore.md` — 6 HIGH findings, all SXPG_COMMAND_EXECUTE and AL11-style file I/O.

## Related

- `security-review.md` — sibling skill. SXPG_COMMAND_EXECUTE shows up in both: security asks "is the call safe?", CleanCore asks "is the call allowed in Cloud?".
- The wider migration context for this customer is in `../codebase-analysis/examples/05-result.md` — the SFTP replacement plan also lifts most CleanCore issues found here.
- `aggregation.md` — Stage 6.
