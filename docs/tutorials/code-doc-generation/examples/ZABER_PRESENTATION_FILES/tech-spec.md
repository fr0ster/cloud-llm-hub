# Technical Specification — ZABER_PRESENTATION_FILES

Assembled from `evidence/evidence.md` per template
`templates/tech-spec-structure.md`. Every claim cites either a metadata field or a
source line; verbatim source lives in `curl/source.md`.

## 1. General information

| Parameter           | Value                                              |
|---------------------|----------------------------------------------------|
| Object name         | `ZABER_PRESENTATION_FILES`                         |
| Object description  | Work with files on the presentation server         |
| Object type         | Executable Program (PROG)                          |
| Application area    | Education / mentor program (package context)       |
| Created by          | `ABEREZKIN`                                        |
| Created on          | 2024-03-16                                         |
| Last modified by    | `ABEREZKIN`                                        |
| Last modified on    | 2026-01-03                                         |
| Package             | `ZABEREZKIN_MENTOR_PR_ACA`                         |

Source of all values: `ReadProgram(ZABER_PRESENTATION_FILES)` →
`curl/meta.md`.

## 2. Purpose and Functionality

The report is a small utility for moving authorization-table contents between the SAP
backend and the user's workstation file system. It exposes four mutually exclusive
operations on its selection screen:

- **Create** (`rb_crea`) — read all rows from the authorization table, write them as a
  CSV to the presentation server, optionally email the CSV to the operator.
- **Display** (`rb_disp`) — upload a previously saved CSV from the workstation and show
  its contents in a popup.
- **Add user** (`rb_add`) — upload a CSV, append one extra row in memory, save it back.
- **Delete** (`rb_del`) — delete the named file on the workstation.

The report does not modify the database; the authorization table is read-only from its
point of view. The single hard-coded "add user" row and the hard-coded sender address in
the email module indicate this is an educational example rather than a production
utility (see §9 — Open questions, items 1–2).

## 3. Program includes

| Include name              | Description                                         |
|---------------------------|-----------------------------------------------------|
| `ZABER_PRESEN_FILES_TOP` | Global declarations (`gt_users TYPE TABLE OF zaber_auth`, `gv_filename TYPE string`) |
| `ZABER_PRESEN_FILES_SS`  | Selection-screen definition (radio buttons + email block) |
| `ZABER_PRESEN_FILES_F01` | FORM routines for download, upload, delete, email   |

Source: `GetIncludesList(ZABER_PRESENTATION_FILES)`.

## 4. Selection screens

| Field    | Type                                                 | Data type           | Purpose                                |
|----------|------------------------------------------------------|---------------------|----------------------------------------|
| `rb_crea`| `PARAMETERS RADIOBUTTON GROUP rb1` + `USER-COMMAND ucc` | — (X / blank)     | Create CSV + email mode                |
| `p_send` | `PARAMETERS AS CHECKBOX DEFAULT 'X'` + `USER-COMMAND ucb` | — (X / blank) | "Send email" toggle (block `bl1`)      |
| `p_email`| `PARAMETERS TYPE ad_smtpadr`                         | `ad_smtpadr`        | Optional recipient override            |
| `rb_disp`| `PARAMETERS RADIOBUTTON GROUP rb1`                   | — (X / blank)       | Display mode (upload + show)           |
| `rb_del` | `PARAMETERS RADIOBUTTON GROUP rb1`                   | — (X / blank)       | Delete-file mode                       |
| `rb_add` | `PARAMETERS RADIOBUTTON GROUP rb1`                   | — (X / blank)       | Add-user mode (upload + append + save) |
| `p_file` | `PARAMETERS TYPE rlgrap-filename`                    | `rlgrap-filename`   | File path on workstation (F4 helper)   |

`rb_crea / rb_disp / rb_del / rb_add` are mutually exclusive (group `rb1`).
`p_send` + `p_email` are only meaningful when `rb_crea = X` (the email is only triggered
in the "create" branch — see §8).

## 5. Database tables

No standard DDIC tables are referenced. The single table the report touches is in the
customer namespace and is listed in §7.

## 6. CDS views

None referenced.

## 7. Custom program objects

| Object name | Description    | Package          |
|-------------|----------------|------------------|
| **Tables**  |                |                  |
| `ZABER_AUTH`| Authorization (keys `MANDT`, `NAME` — `SYUNAME`) | (not returned by `GetTable`) |

This is the only `Z*` object referenced from the report's source. The package field was
not returned in this MCP call — record as `[UNKNOWN — GetTable response did not include
the package; verify with DescribeObject]`.

## 8. Logic overview

**Entry points**

- `AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file` — invokes `PERFORM get_filename` to
  launch the standard F4 file picker via function module `F4_FILENAME`.
- `START-OF-SELECTION` — main dispatch (see flow below).

**Main flow**

```
START-OF-SELECTION
  IF rb_crea = X:
    gv_filename = sy-uname && ' ' && sy-datum && '.csv'
    SELECT * FROM zaber_auth INTO gt_users
    PERFORM download_file USING gv_filename     -- cl_gui_frontend_services=>gui_download
    PERFORM send_email                          -- BCS-based, sender hard-coded
  ELSE:
    IF p_file IS INITIAL: message, return
    CASE rb_*:
      rb_disp -> PERFORM upload_file            -- gui_upload
                 SRTT_TABLE_DISPLAY shows gt_users
      rb_add  -> PERFORM upload_file
                 APPEND hard-coded name 'Andrey Berezkin'
                 PERFORM download_file USING p_file
      rb_del  -> PERFORM delete_file            -- file_delete
```

**Key implementation choices**

- The "create" filename is auto-generated from `sy-uname` + `sy-datum`. Users in two
  countries on the same `sy-uname` produce different filenames per day; users sharing a
  Windows account collide.
- The "add user" row's name is hard-coded literal `'Andrey Berezkin'` — almost certainly
  demo data. Not driven by any parameter or table lookup.
- "Display" mode shows the **uploaded** CSV, not the live table. To see the current
  `zaber_auth`, the user must run `rb_crea` first.

**Error handling**

- Each presentation-server call wraps `EXCEPTIONS OTHERS = 1` and emits an `S`-type
  message *displayed like* `E` on `sy-subrc <> 0`. The report then `RETURN`s — no
  further work attempted.
- BCS calls wrap a `TRY ... CATCH cx_document_bcs cx_send_req_bcs cx_address_bcs` block;
  any of the three exceptions issues `'Message not sent'` and returns.
- The `MESSAGE 'Select a file'` guard prevents the read modes from running with an
  empty `p_file`.

## 8.1 External effects

- **Presentation-server file I/O** via `cl_gui_frontend_services=>` `gui_download` /
  `gui_upload` / `file_delete`.
- **Email** via the BCS framework. Specifics:
  - Sender: hard-coded `andrey_berezkin@epam.com` (literal in source).
  - Recipient: `p_email` if filled, else `cl_sapuser_bcs=>create(sy-uname)` (i.e. the
    current SAP user's mapped email).
  - Document subject: `'New file is created'`. HTML body literal `'Additional body'`.
  - Attachment: the CSV produced from `gt_users` via
    `SOTR_SERV_TABLE_TO_STRING` → `SCMS_STRING_TO_XSTRING` →
    `cl_bcs_convert=>xstring_to_solix`. Type tag `'BIN'`, subject `'file.csv'`.
  - Send: `set_send_immediately(abap_true)` then `lo_send_request->send()` then
    `COMMIT WORK` (required for BCS persistent send-request to flush).
- **Database**: read-only on `ZABER_AUTH`. No `MODIFY`, `UPDATE`, `INSERT`, `DELETE`
  against any DDIC table.
- **Authorization**: no `AUTHORITY-CHECK` anywhere in the report.

## 9. Open questions

1. **Sender hard-coded.** `andrey_berezkin@epam.com` is the only sender. Should the
   sender come from `sy-uname` (`cl_sapuser_bcs`) or a configuration table if the report
   is reused by another operator? Confirm with the author.
2. **"Add user" hard-coded.** The `<ls_user>-name = 'Andrey Berezkin'` literal in
   `rb_add` mode looks like demo data. Should the added row come from a parameter, a
   pop-up, or a second uploaded file?
3. **No authorization.** Acceptable for an educational sandbox, but if this report is
   ever run in a non-sandbox client it should `AUTHORITY-CHECK` on the table read and on
   the file-delete operation.
4. **Recipient fallback.** When `p_email` is empty, the email goes to
   `cl_sapuser_bcs=>create(sy-uname)`. This silently fails if `sy-uname` has no mapped
   email address. Worth either pre-checking or surfacing the failure.
5. **CSV shape.** `gui_download` is called on a table-of-`zaber_auth` (two columns).
   No header line, no escaping, no encoding declaration. If anything downstream consumes
   this file, the shape contract should be documented.
6. **"Display" semantics.** The display mode shows the **uploaded** CSV, not the live
   `ZABER_AUTH`. If "display the current authorization table" was the intent, the mode
   is misnamed; if "display whatever the user uploaded" was the intent, the label could
   be clearer (e.g. "show file contents").
7. **Caller scan.** This report's `where-used` was not run as part of this analysis. If
   another report submits this one or calls its FORMs (via cross-include — unusual but
   possible), that linkage isn't captured here.
