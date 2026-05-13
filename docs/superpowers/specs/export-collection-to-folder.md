# Spec: Export Collection To Folder

**Issue:** #77
**Status:** draft, pre-implementation

## TL;DR

Add a way for users of the chat UI to dump every entry of a RAG collection into a downloadable ZIP archive, one file per entry. User picks the format (`md` with YAML front-matter, or `txt` with optional `.meta.json` sidecar) so collections of markdown notes and plain-text snippets both round-trip cleanly.

## Why

Today the only way to inspect a curated collection is through the chat UI's per-document list or by reading the Postgres row directly. There's no way to snapshot a collection for git, share it via folder hand-off, or diff "UI state" vs. "what we expected on disk." Curation work is invisible outside the running app.

## Non-goals

- **No `ImportFromFolder` tool or route** in this iteration. The existing `POST /v1/rag/collections/:id/upload` endpoint already does single-file ingestion with chunking; a true round-trip importer that consumes the export ZIP is a follow-up issue.
- **No standalone LLM-selectable export tool.** Export is a deterministic HTTP/UI action in v1. If we later need assistant-initiated export, expose it as a parameter on a single existing/future RAG action surface, not as a second similar tool that the LLM must choose between.
- **No deletion / move-on-export.** Read-only operation.
- **No embeddings export.** Only the original text and metadata. Embeddings are reproducible from text via the provider's embedding model; shipping them would lock the consumer to one model version.
- **No multi-collection bulk export.** One collection per call. Loop client-side if needed.

## Design

### UI-only export, no server route

```
   chat UI (browser)
        │
        ▼
 existing RAG/MCP read operations
   - list collection entries
   - read each entry text + metadata
        │
        ▼
 client-side archive builder
   - format each entry as .md or .txt
   - add .meta.json sidecars when needed
   - generate ZIP Blob
        │
        ▼
 browser download
```

No new server endpoint is added for v1. The UI orchestrates export by reading the collection through the existing RAG/MCP read surface, then generates the ZIP in the browser. This avoids introducing a second LLM-selectable alternative and avoids touching `srv/*` for a read-only convenience feature.

### Per-entry file layout inside the ZIP

For each `RagDocument { id, text, metadata, createdAt }`:

| `format` | File | Body | Metadata |
|---|---|---|---|
| `md` | `<safe(id)>.md` | YAML front-matter block when there is metadata to preserve, then `text` as-is | Front-matter keys: `id`, `createdAt`, plus all exportable `metadata.*`. If metadata is empty after internal-key filtering, omit front-matter entirely and write raw text only. |
| `txt` | `<safe(id)>.txt` | `text` as-is, no header | If non-empty metadata to record: `<safe(id)>.meta.json` sidecar with `{ id, createdAt, metadata }` |

`safe(id)` = replace `[^A-Za-z0-9._-]` with `_`, truncate to 120 chars. Collisions resolved with `-<n>` suffix before the extension. We keep a `Set<string>` per export run to detect them.

### UI contract

The export dialog accepts:
- `collection`: selected collection id from the RAG modal row.
- `format`: `md` or `txt`, default `md`.
- `include_deprecated`: boolean, default `false`.

The UI produces a browser download named `<collection>-<UTCdate>.zip`.

The archive builder returns `{ blob, documentCount, fileCount }` internally so the UI can show success/failure details if needed.

**LLM/tooling:**

Do not register a standalone `ExportCollectionToFolder` tool in `TOOL_DEFS` or in the real MCP protocol for v1. Export should not create a second LLM-selectable alternative next to related RAG operations. If an assistant-driven workflow is needed later, model export as a parameter on one unified RAG action surface.

### Authorization

No new authorization path is introduced. Export can only read what the UI can already read through the existing RAG/MCP read operations. Do not add a new server-side route or bypass the existing read surface.

### `include_deprecated`

Entries tagged with `deprecated` or `superseded` in `metadata.tags` are filtered out by default. Pass `include_deprecated=true` to include them — useful for taking a full snapshot before pruning.

### Size and client-side ZIP generation

The ZIP is built in the browser from the retrieved records. Use a browser-compatible ZIP helper loaded with the chat webapp (for example a vendored/minified JSZip asset or another local browser ZIP implementation). Do not add server-side ZIP generation.

Soft-cap v1 at 10k entries / 50MB uncompressed in the UI. If exceeded, show a clear error suggesting `include_deprecated=false` and/or splitting the collection manually. No server-side 413 exists because there is no export endpoint.

## Acceptance criteria

- [ ] UI export for `format=md` reads all entries in the selected collection and downloads a valid ZIP; `unzip -l` shows N entries with `.md` extension.
- [ ] Same for `format=txt` → `.txt` extension.
- [ ] In `md` mode: entries with non-empty metadata have a YAML front-matter block; entries with empty metadata have raw text only.
- [ ] In `txt` mode: `.txt` files are pure text; sidecar `.meta.json` appears only when entry has non-empty metadata to preserve.
- [ ] No standalone `ExportCollectionToFolder` tool is registered in `srv/rag-tool-dispatcher.ts` or the MCP protocol.
- [ ] No new `srv/*` route, handler, or server-side ZIP builder is added.
- [ ] Filename collisions across the `safe(id)` transform produce `-1`, `-2`, ... suffixes; no overwrites.
- [ ] `include_deprecated=false` skips entries with `tags: ['deprecated']` or `['superseded']`; `=true` keeps them.
- [ ] If the existing RAG/MCP read surface denies access, the UI surfaces that error and does not generate a partial ZIP.
- [ ] UI/helper test: 3-entry mock collection, both formats, asserts on filename list, content, sidecar presence/absence.
- [ ] Smoke test on dev: open chat UI → RAG modal → click "Export" on a real collection → ZIP downloads → contents open in an editor.

## UI

Minimal additions to `app/chat/webapp/index.html`:

1. New per-collection action button "Export" in the collections list (line ~120 of the RAG modal markup).
2. New `<div id="export-modal">` dialog (sibling to `rag-modal`) with:
   - Format radio (`md` default, `txt`).
   - "Include deprecated" checkbox (off default).
   - Cancel / Download buttons.
3. Download button reads all records through the existing RAG/MCP read surface, builds the ZIP Blob in the browser, then programmatically clicks a hidden object-URL `<a download>` to trigger the browser save dialog.

No changes to the toolbar `.system-bar`. No new icons required (text label "Export" is fine).

## Out of scope reminders

- `ImportFromFolder` tool/route → separate issue.
- Embedding export → not now.
- Bulk multi-collection export → not now.

## File-level surface (implementation map)

| Change | File | Notes |
|---|---|---|
| Edit | `app/chat/webapp/index.html` | Export button, modal, client-side record reading, ZIP generation, download trigger. |
| New/Edit | Browser ZIP helper asset (path decided in plan) | Local webapp asset only; no server route. |
| New | UI/unit test target (path decided in plan) | Tests for formatting, collision handling, deprecated filtering, and ZIP file list if feasible. |
| Edit | `docs/usage/FOR_USER.md` (or appropriate audience doc) | One paragraph + example screenshot description. |

## Open questions (resolve in PR review)

1. **Read surface exact calls** — confirm which existing UI-accessible RAG/MCP read operation lists all entries and reads text/metadata. Do not add a new server route for export.
2. **Client ZIP helper** — decide whether to vendor JSZip under `app/chat/webapp/` or use another local browser ZIP implementation.

## Sequencing

1. Spec (this doc) ← reviewed.
2. Plan (`docs/superpowers/plans/export-collection-to-folder.md`) ← next.
3. Implementation in milestones (UI read helpers, client ZIP, modal, docs).
4. Each milestone gets a review checkpoint per `Спека → план → реалізація з ревью` workflow.
