# 02-methods - SFTP methods

> Example artifact, not a template.

## Declared scope

From `01-task.md`: `Z*` namespace in `<system>`, plus seed objects and reachable in-scope callers.

## Seed verdicts

| Seed | Verdict | Method | Evidence |
|---|---|---|---|
| `Z_VENDOR_A_PULL` | yes | `SXPG_COMMAND_EXECUTE` external command | `Z_VENDOR_A_PULL:L142` call to `SXPG_COMMAND_EXECUTE` |
| `Z_VENDOR_B_FILEPROC` | yes | local form wrapping `SXPG_COMMAND_EXECUTE` | include `Z_VENDOR_B_FILEPROC_F01`, form `f_get_sftp_file_data` |
| `Z_VENDOR_H_PDF_PROC` | yes | custom FMs `Z_MED_GET_FROM_SFTP` / `Z_MED_PUT_FROM_SFTP` | form calls both FMs |
| `Z_EDI_INBOUND_LOADER` | unclear | consumes app-server files; no direct SFTP call | source reads directory/file, no SFTP primitive found |

## Blind spots

None for seed source readability. The source-search report name was confirmed as `<standard-abap-source-search-report>` before Stage 3.

## Stage 3 input

Methods to traverse/search:

- `SXPG_COMMAND_EXECUTE`
- `Z_MED_GET_FROM_SFTP`
- `Z_MED_PUT_FROM_SFTP`
- substring `sftp`
