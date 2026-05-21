---
name: Managing RAG Artifacts
description: Rules for saving, correcting, and deprecating named artifacts in a working RAG collection — stable ids, no overwrites, evidence-first
tags: [rag, artifact-lifecycle]
---

# Managing RAG Artifacts

A working RAG collection is the persistent state between conversation sessions. Each
named artifact is addressed by a **stable, human-readable id** the agent passes to all
three RAG tools.

## Tool choice

| Operation                              | Tool            | When                                                         |
|----------------------------------------|-----------------|--------------------------------------------------------------|
| Save a new artifact                    | `rag_add`       | First time you save an artifact under a given id.            |
| Update an existing artifact            | `rag_correct`   | Any time after the first save. **Not** a second `rag_add`.   |
| Remove an artifact entirely            | `rag_deprecate` | The artifact is no longer relevant; no replacement.          |

## `rag_add`

Fields:

- `collection` — the working collection name (e.g. `book-catalog`).
- `id` — a stable id, e.g. `business-requirements`.
- `text` — the full artifact body (markdown).
- `tags` — categorical labels (e.g. `["requirements"]`).

After the call, state to the user: *"Saved as `<id>` in collection `<name>`."*

## `rag_correct`

Use it when you discover an error in an artifact already saved. Pass:

- `collection`, `id` — same as the original save.
- `newText` — the **full corrected body**, not a diff. Previous text is overwritten in
  place. The same id keeps pointing at the new content.
- `reason` — one short sentence, stored as `lastCorrectedReason`.

After the call, state: *"Corrected `<id>`. Reason: `<reason>`."*

## `rag_deprecate`

Removes the record. No soft-delete. The id is free to be re-added afterwards. Use this
when an artifact is permanently irrelevant (scope dropped, entity removed entirely).

## Hard rules

- **Never call `rag_add` twice on the same id** — the dispatcher refuses with
  *"Active record already exists"*. Use `rag_correct`.
- **The id is stable.** Never invent `business-requirements-v2`, `tech-spec-new`. The
  same id always points at the latest active version.
- **No UUIDs in conversation memory.** Address artifacts by id only.

## Special case — caller does not own the collection

If the user points the agent at a collection where the id convention differs (or where
free-form ids are expected), omit `id` on the `rag_add` call. The system assigns a
UUID; the user then addresses those records via the MANAGE panel, not via the agent.
