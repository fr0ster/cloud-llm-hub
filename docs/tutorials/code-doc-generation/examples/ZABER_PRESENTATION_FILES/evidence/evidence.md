# evidence — ZABER_PRESENTATION_FILES

> Consolidated evidence file. For larger objects each spec section would get its own
> file (`evidence-§1.md` … `evidence-§9.md`); for a ~250-line report a single artifact
> is enough.

Source cached at: `curl/source.md` (verbatim dump of main + 3 includes).
Metadata cached at: `curl/meta.md`.
Standard-table description cached at: `curl/deps.md`.

## §1 — General information (evidence)

From `curl/meta.md` (`ReadProgram` call):

| Field         | Value                                           |
|---------------|-------------------------------------------------|
| Program type  | Executable Program                              |
| Description   | Work with files on the presentation server      |
| Package       | `ZABEREZKIN_MENTOR_PR_ACA`                      |
| Author        | `ABEREZKIN`                                     |
| Created on    | 2024-03-16                                      |
| Last changed  | 2026-01-03 by `ABEREZKIN`                       |

## §2 — Purpose (evidence)

The report has no header comment beyond the standard banner. Purpose derived from:

- The program description in metadata: *"Work with files on the presentation server"*.
- The selection screen layout (`ZABER_PRESEN_FILES_SS`) which presents four mutually
  exclusive actions: **create** (`rb_crea`), **display** (`rb_disp`), **delete**
  (`rb_del`), **add user** (`rb_add`).
- The four FORM routines in `ZABER_PRESEN_FILES_F01`: `download_file`, `upload_file`,
  `delete_file`, `send_email`.
- The single DB read targets `zaber_auth` (custom Z-table; description *"Authorization"*).

Classification: an educational/utility report (author ABEREZKIN is the SAP-mentor-program
trainer; package prefix `ZABEREZKIN_MENTOR_PR_*` is consistent with that).

## §3 — Program includes (evidence)

From `GetIncludesList`:

| Include name              | What it holds                                       |
|---------------------------|-----------------------------------------------------|
| `ZABER_PRESEN_FILES_TOP`  | Global data declarations (`gt_users`, `gv_filename`)|
| `ZABER_PRESEN_FILES_SS`  | Selection-screen definition                         |
| `ZABER_PRESEN_FILES_F01` | FORM routines (download/upload/delete/email)        |

## §4 — Selection screen (evidence)

From `ZABER_PRESEN_FILES_SS`:

| Field    | Element                          | Data type           | Purpose                                 |
|----------|----------------------------------|---------------------|-----------------------------------------|
| `rb_crea`| `PARAMETERS RADIOBUTTON GROUP rb1` (with `USER-COMMAND ucc`) | — | Create CSV + email mode                 |
| `p_send` | `PARAMETERS AS CHECKBOX DEFAULT 'X' USER-COMMAND ucb`        | — | "Send email" toggle inside block `bl1`  |
| `p_email`| `PARAMETERS TYPE ad_smtpadr`     | `ad_smtpadr` (SMTP) | Optional recipient override             |
| `rb_disp`| `PARAMETERS RADIOBUTTON GROUP rb1`| —                  | Display mode (upload + show)            |
| `rb_del` | `PARAMETERS RADIOBUTTON GROUP rb1`| —                  | Delete-file mode                        |
| `rb_add` | `PARAMETERS RADIOBUTTON GROUP rb1`| —                  | Add-user mode (upload + append + save)  |
| `p_file` | `PARAMETERS TYPE rlgrap-filename`| `rlgrap-filename`   | File path (with F4 helper)              |

The four `rb_*` radio buttons are mutually exclusive (group `rb1`). `p_send` + `p_email`
are only meaningful when `rb_crea = X`.

## §5 — Database tables (evidence)

The code touches **one** table — `zaber_auth`. It is in the customer namespace (Z-prefix),
so it is documented in §7, not §5. The report references no standard DDIC table.

Citation: `ZABER_PRESENTATION_FILES` line `SELECT * FROM zaber_auth INTO TABLE @gt_users.`

## §6 — CDS views (evidence)

None referenced in source. No `Z..._C_…` / `Z..._R_…` / `_I_…` identifiers found.

## §7 — Custom program objects (evidence)

Only the customer-namespace object referenced is the table `ZABER_AUTH`:

| Object name | Type | Description    | Key fields    |
|-------------|------|----------------|---------------|
| `ZABER_AUTH`| TABL | Authorization  | `MANDT`, `NAME` (`SYUNAME`) |

Citation: `GetTable(ZABER_AUTH)` → see `curl/deps.md`. Two columns total: `MANDT` and
`NAME` (typed by `SYUNAME` — user-name data element). The report reads all rows into
`gt_users` and writes the same set out as CSV.

## §8 — Logic overview (evidence)

Entry points and control flow:

1. **`AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file`** — when the user opens the F4
   helper on `p_file`, calls `PERFORM get_filename`, which invokes function module
   `F4_FILENAME` to fill `p_file`.

2. **`START-OF-SELECTION`** — main dispatch:
   - If `rb_crea = abap_true`:
     - Build `gv_filename = sy-uname && ' ' && sy-datum && '.csv'`.
     - `SELECT * FROM zaber_auth INTO TABLE @gt_users`.
     - `PERFORM download_file USING gv_filename` (writes CSV via
       `cl_gui_frontend_services=>gui_download`).
     - `PERFORM send_email` (BCS-based email; sender hard-coded to
       `andrey_berezkin@epam.com`, recipient from `p_email` or current user).
   - Else (one of `rb_disp` / `rb_del` / `rb_add`):
     - Refuse if `p_file` empty (`MESSAGE 'Select a file'` and `RETURN`).
     - `rb_disp` → `PERFORM upload_file` then `SRTT_TABLE_DISPLAY` shows the loaded
       rows.
     - `rb_add` → `PERFORM upload_file`, append a row with hard-coded name
       `Andrey Berezkin`, then `PERFORM download_file USING p_file` (writes back).
     - `rb_del` → `PERFORM delete_file` (uses
       `cl_gui_frontend_services=>file_delete`).

3. **`PERFORM` graph** (all four FORMs are in `ZABER_PRESEN_FILES_F01`):

```
get_filename   ← AT SELECTION-SCREEN ON VALUE-REQUEST
download_file  ← rb_crea (auto-named) and rb_add (user-named)
upload_file    ← rb_disp, rb_add
delete_file    ← rb_del
send_email     ← rb_crea (after download)
```

## §9 — External effects (evidence)

- **Presentation-server file I/O.** Via `cl_gui_frontend_services` →
  `gui_download` / `gui_upload` / `file_delete`. No app-server `OPEN DATASET`. Visible
  in `F01.download_file`, `F01.upload_file`, `F01.delete_file`.
- **Email.** Via the BCS framework (`cl_bcs`, `cl_cam_address_bcs`, `cl_document_bcs`,
  `cl_bcs_convert`). Sender hard-coded to `andrey_berezkin@epam.com`; recipient is
  `p_email` if filled, else the current SAP user (`cl_sapuser_bcs=>create(sy-uname)`).
  HTML body literal `'Additional body'`; attachment carries the CSV produced from
  `gt_users` (via `SOTR_SERV_TABLE_TO_STRING` → `SCMS_STRING_TO_XSTRING` →
  `cl_bcs_convert=>xstring_to_solix`). The send is `set_send_immediately( abap_true )`
  followed by `COMMIT WORK`.
- **DB read only.** The report reads `zaber_auth`; it **does not** write to that table.
  The "add user" mode appends to the in-memory `gt_users` and writes the CSV — it does
  not update DDIC.
- **No AUTHORITY-CHECK** in any of the four operations or before the BCS send.
- **No `MODIFY`/`UPDATE`/`INSERT`** of DDIC tables anywhere in the source.

## §9 — Open questions (gaps)

1. Sender address is hard-coded to `andrey_berezkin@epam.com`. Is that by design (single
   trainer) or a stub? If the report is reused, the sender should come from
   configuration or `sy-uname → cl_sapuser_bcs`.
2. "Add user" mode appends a hard-coded literal `'Andrey Berezkin'`. The literal looks
   like demo data — likely a placeholder, not an intended business rule.
3. No `AUTHORITY-CHECK` before delete or before download. Acceptable for an educational
   sandbox, not for a production utility.
4. Recipient fallback to current SAP user assumes the user has an email address mapped
   to their `sy-uname`. Not verified in source — fails silently if missing.
5. CSV format: the file is produced by `gui_download` on `gt_users`. Column order = DDIC
   order of `zaber_auth` (`MANDT`, `NAME`). No header line; no escaping. Whether a
   downstream consumer is expecting a specific shape is unknown.
6. The "display" mode shows the **uploaded** file via `SRTT_TABLE_DISPLAY`. There is no
   button or sub-path that displays the live `zaber_auth` contents — that would require
   `rb_crea` first then a separate `rb_disp` on the just-written file.
