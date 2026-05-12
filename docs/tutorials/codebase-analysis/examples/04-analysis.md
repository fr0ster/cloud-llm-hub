# 04-analysis - SFTP usage interpretation

> Example artifact, not a template.

## Axes

- Direction: inbound / outbound / bidirectional.
- Purpose: generic business purpose category.
- Boundary: perimeter / internal-wrapper.
- Pattern: recurring implementation shape.

## Analysis

| Caller | Direction | Purpose | Boundary | Pattern | Evidence |
|---|---|---|---|---|---|
| `Z_VENDOR_A_PULL` | inbound | unknown | perimeter | config table -> command string -> `SXPG_COMMAND_EXECUTE` | command contains get-style parameters; purpose hidden behind config key |
| `Z_VENDOR_B_FILEPROC` | inbound | payments | internal-wrapper for SFTP | local wrapper before posting | source posts via accounting BAPI after file read |
| `Z_VENDOR_H_PDF_PROC` | bidirectional | documents | perimeter | reusable `Z_MED_*` wrappers | get and put FM calls in separate forms |
| `Z_VENDOR_I_INBOX_DISPATCH` | inbound | documents | perimeter | reusable `Z_MED_GET_FROM_SFTP` | where-used caller of inbound FM |

## Open questions

- What business purpose hides behind the opaque `Z_CFG_TABLE` keys?
- Are app-server directory consumers in migration scope?
- Should the `Z_MED_*` wrappers become a public migration boundary or remain internal?
