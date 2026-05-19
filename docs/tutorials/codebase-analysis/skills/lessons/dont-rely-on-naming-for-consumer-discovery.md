---
name: dont-rely-on-naming-for-consumer-discovery
description: Never trust object names to be complete or honest about what they do — use SearchSource on call literals and WhereUsed on confirmed artifacts instead
trigger: about to enumerate consumers of a mechanism via "scan for X_SFTP-shaped names" or similar name-pattern search
---

# Lesson — names lie; use tool-based discovery, not name-based

## The rule

When enumerating consumers of a mechanism (SFTP, IDoc, RFC, whatever) in an unfamiliar customer codebase, **do not rely on the object name carrying the mechanism word**.

Use these tools instead, in this order:

1. **`SearchSource` on the call-site literal** — for example, `query="SXPG_COMMAND_EXECUTE"` paired with a credential or destination literal that pins it to SFTP specifically. This catches every direct caller regardless of how the caller's object is named.
2. **`SearchSource` on the constants/credential-bag literal** — `query="PRIVATE_KEY_PATH"`, `query="FTP_PSWD"`, or `query="ZSFTP_"` (matching the `pname = 'ZSFTP_*'` literals in `zfi_constants` lookups). Catches every place credentials are read, which has to happen before any SFTP call.
3. **`GetWhereUsed` on every confirmed wrapper artifact** — once Step 1/2 surfaces a wrapper FM (or class, or report), run WhereUsed on each. This is the authoritative way to find callers.
4. **Cross-reference and union the results**. A complete list is the union of (1)+(2)+(3). Claim completeness only when at least two of these three converge to the same set.

## What NOT to do

- Do not assume that "SFTP consumers will have SFTP in the name". They don't always. Examples from the 2026-05-19 run:
  - `ZFFIU_ACC_POST` — an FI report. No SFTP in name. Pulls payroll over SFTP.
  - `ZSD_MEDICARE_PDF_PROCESS` — an SD report. No SFTP in name. Uses SFTP wrapper.
  - `ZSD_ERX_DMS_FILE_PROCESS` — an SD report. No SFTP in name. Uses SFTP wrapper.
  - `ZDMS_REPLACE_FILES`, `ZDMS_UPLOAD_FILES` — DMS reports. No SFTP in name. Direct SXPG SFTP callers.
- Do not assume one naming convention covers all wrappers. The same estate had `_FROM_SFTP` (ZMEDI/ZERX wrappers) and `_TO_SFTP` (`ZDMS_EXTRACT_DOCS_TO_SFTP` in ZDMS_SEND_FILE FUGR). A substring scan on one convention missed the other.

## Worked example

Stage 3 of the 2026-05-19 run did:

- Initial substring scan: `_FROM_SFTP` → 6 objects (ZMEDICARE FUGR + ZERX FUGR + 4 callers with `PERFORM f_get_files_from_sftp` form names).
- Credential-bag scan: `PRIVATE_KEY_PATH` → 6 objects (ZERX + ZMEDICARE + 4 direct-caller PROGs).
- Sanity scan: `ZSFTP_` (SM69-prefix literal) → 13 objects, one of them new: `ZDMS_SEND_FILE` FUGR. Reading the FUGR surfaced wrapper FM `ZDMS_EXTRACT_DOCS_TO_SFTP` — naming convention here was `_TO_SFTP`, missed by the `_FROM_SFTP` substring scan.

Without the SM69-prefix scan, ZDMS_SEND_FILE would not have surfaced — name-based scanning failed but tool-based scanning (looking for the `ZSFTP_*` SM69-name literal) caught it.

## How to apply this

When you're tempted to write a substring scan like `query="<mechanism>_GET"` or `query="_FROM_<mechanism>"`:

1. Stop. Ask: what would the call-site of this mechanism look like literally in source? That's your real scan target (e.g., `SXPG_COMMAND_EXECUTE`, `CALL FUNCTION 'CL_...`).
2. If that scan is too broad, narrow by ANDing with a mechanism-specific literal (e.g., a credential parameter name, a destination identifier).
3. Once the scan returns a set of wrapper artifacts (FMs, classes), use `GetWhereUsed` on each — that's how you find callers reliably.
4. Only after these are done, consider name-pattern scans as a *sanity check* — they can find what you may have missed when picking literals, but they're never the primary source of truth.

## Related

- `using-searchsource.md` — the operating manual for the SearchSource tool itself.
- `lessons/cross-domain-naming-is-normal.md` — companion finding: FI reports call payroll SM69s; expect names to lie about domain.
- `method-discovery.md` — the Stage-2 driver skill; should reference this lesson when describing the verdict procedure.
