# 01-target — Code-review target

## Target object

- **Name:** `ZDMS_UPLOAD_FILES`
- **Type:** PROG (executable report)
- **Package:** `Z001`
- **Destination:** `DS4_CLH` (EPAM ai-applications subaccount, eu10-004)
- **Origin context:** identified as SFTP usage site in the 2026-05-19 sFTP codebase analysis (`docs/tutorials/codebase-analysis/examples/`). Calls `SXPG_COMMAND_EXECUTE` for both pull (`ZSFTP_DMS_GET`) and push (`ZSFTP_DMS_PUT`) operations via SM69 entries.

## Scope of review

- **In:** main program source + every include returned by `GetIncludesList`.
- **In:** the four standard defect-category checks (security, performance, CleanCore, maintainability).
- **Out:** code outside this program (`zfi_constants` table structure, SM69 entry contents, OS-side scripts).
- **Out:** refactor proposals beyond the per-finding `Recommendation` line.

## Severity scale

| Severity | Definition | Examples |
|---|---|---|
| **CRITICAL** | Likely to cause data loss, security breach, or production outage. Fix before next release. | Hardcoded production credentials; SQL injection via concatenated dynamic SQL; missing AUTHORITY-CHECK on sensitive transaction. |
| **HIGH** | Functional or compliance defect that's bypassable but real risk. Fix this quarter. | Missing SY-SUBRC handling after critical CALL; non-released API in S/4HANA Cloud context; SELECT in LOOP on a large table. |
| **MEDIUM** | Maintainability or perf issue that doesn't block but increases technical debt. | Magic numbers; FORM > 200 lines; missing index hint on a SELECT with full table scan. |
| **LOW** | Style/idiom issue. Fix during normal evolution. | Obsolete syntax (`CONCATENATE` → string templates); long variable names; mixed indent. |
| **INFO** | Note for future awareness, not a defect. | "FUGR wrapper pattern observed — consider for refactor when migration starts." |

## Available SAP tools (confirmed against current MCP server)

- `ReadProgram(name)` — main program source.
- `GetIncludesList(name)` — list of include names (recursive).
- `GetInclude(include_name)` — source of one include.
- `GetFunctionModule(name, function_group_name?)` — source of a function module (relevant when reviewing wrappers).
- (Not used in this review) `SearchObject`, `SearchSource` — these are codebase-analysis tools, not per-object review.

## Out of scope (deliberate)

- Refactor / fix proposal beyond per-finding `Recommendation`.
- Cross-object review (e.g., comparing ZDMS_UPLOAD_FILES with ZDMS_REPLACE_FILES). The pipeline can be re-run per object.
- OS-side script behavior reachable only through SM69 (Basis access required).
- DDIC objects referenced by the program (`zfi_constants` table, `btcxpm`, `extcmdexex` types).

## Run artifacts

```
docs/tutorials/code-review/examples/ZDMS_UPLOAD_FILES/
  01-target.md                  (this file)
  02-security.md
  03-performance.md
  04-cleancore.md
  05-maintainability.md
  06-summary.md
  report.pptx
  RETRO.md
  curl/                         (one SmartAgent request/response per check)
```
