---
name: reading-draft-table
description: Read / inspect a draft table for a RAP business object — its rows are transient working copies, not the source of truth, the %admin include carries the draft-technical fields, and its keys mirror the persistent table
---

# Reading a draft table

A draft table holds in-progress edits, not committed data. Reading it answers "what is this
user currently editing", not "what is true".

## What matters when inspecting

- **Not the source of truth.** A row here can be incomplete, inconsistent, or abandoned — never
  treat draft data as authoritative; cross-check against the persistent table (see
  reading-persistent-table) when you need the committed state.
- **`%admin` include.** Every draft table ends with `include sych_bdl_draft_admin_inc` — this
  carries the draft-technical fields (owner user, timestamp, draft UUID, in-process/locked
  flags). That's where to look for who is editing and since when, not in the business fields.
- **Field names differ from the persistent table.** Draft fields use the CDS element name in
  lowercase with no underscores (persistent `pub_year` / CDS `PubYear` → draft field
  `pubyear`), even though the type stays identical.
- **Keys mirror the persistent table exactly** — same key fields, same types — so a draft row and
  its persistent counterpart are joined 1:1 on the key.

## Common mistake

| Symptom | Fix |
|---|---|
| Treating a draft row's business fields as final | Confirm against the persistent table before reporting it as committed data |
| Looking for the editing user in a business field | It's in the `%admin` include, not a business column |
