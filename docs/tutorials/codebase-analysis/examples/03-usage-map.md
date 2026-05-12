# 03-usage-map - SFTP usage sites

> Example artifact, not a template.

## Declared scope

Customer namespace `Z*` in `<system>`. Complete only within this scope and channels.

## Channels used

- Dependency / where-used traversal: `GetWhereUsed`.
- Source-text search: `<standard-abap-source-search-report>`.

## Search terms

| Term | Reason |
|---|---|
| `SXPG_COMMAND_EXECUTE` | Direct external-command SFTP primitive |
| `Z_MED_GET_FROM_SFTP` | Inbound wrapper FM |
| `Z_MED_PUT_FROM_SFTP` | Outbound wrapper FM |
| `sftp` | Command strings and naming cross-check |

## Usage sites

| Caller | Kind | Method | Channels | Evidence |
|---|---|---|---|---|
| `Z_VENDOR_A_PULL` | report | `SXPG_COMMAND_EXECUTE` | source-search | `L142` call |
| `Z_VENDOR_B_FILEPROC` | report | local wrapper form | source-search | `f_get_sftp_file_data` |
| `Z_VENDOR_H_PDF_PROC` | report | `Z_MED_GET_FROM_SFTP`, `Z_MED_PUT_FROM_SFTP` | where-used, source-search | include form calls both FMs |
| `Z_VENDOR_I_INBOX_DISPATCH` | report | `Z_MED_GET_FROM_SFTP` | where-used | new in-scope caller found from FM traversal |

## Boundaries and blind spots

- Out of scope: SAP standard loaders reached downstream.
- Blind spot: runtime-assembled command names are not ruled out by static search.
- Truncation: no query reached the report cap in this example.

## Completeness answer

Every method from `02-methods.md` was checked through dependency lookup and source-text search. Complete within declared scope and channels only.
