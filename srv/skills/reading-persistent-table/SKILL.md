---
name: reading-persistent-table
description: Read / inspect the persistent table of a RAP business object — the committed source of truth, how to tell key vs business vs audit fields apart, and the active vs inactive DDIC version
---

# Reading a persistent table

The persistent table is the committed, authoritative state — unlike a draft table (see
reading-draft-table), what's here is real unless you're looking at an inactive version.

## What matters when inspecting

- **This is the source of truth.** Any comparison against a draft table, or any "what is the
  real value" question, resolves here.
- **Distinguish the three field roles** before reading meaning into a column:
  - key fields (`key client`, `key <obj>_uuid`, plus any business key) identify the row,
  - business fields carry the actual data,
  - audit fields (`created_by`, `created_at`, `last_changed_by`, `last_changed_at`,
    `local_last_changed_at`) describe the row's history, not its content.
  Don't read an audit field as business data or vice versa.
- **Active vs inactive version.** A table definition can have an inactive (not-yet-activated)
  version alongside the active one — when checking "does this field exist", confirm which
  version you're looking at; an inactive-only change isn't live yet.

## Common mistake

| Symptom | Fix |
|---|---|
| Reporting a field as missing when it's only inactive | Check both the active and inactive DDIC version before concluding |
| Confusing `last_changed_at` (row audit) with `local_last_changed_at` (etag/draft-merge field) | They're different fields with different roles — check which one a BDEF's `etag master` actually references |
