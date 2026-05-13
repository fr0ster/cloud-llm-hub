# Plan: Export Collection To Folder

**Spec:** `docs/superpowers/specs/export-collection-to-folder.md`
**Issue:** #77
**Branch:** `feat/export-collection-to-folder`

## Decisions

1. **UI-only implementation.** Do not add a server export endpoint, `srv/rag-export.ts`, or server-side ZIP builder. The chat UI reads collection entries through the existing RAG/MCP read surface and builds the ZIP in the browser.
2. **No standalone LLM-selectable tool.** Do not add `ExportCollectionToFolder` to `srv/rag-tool-dispatcher.ts` or to the real MCP protocol. If a future assistant flow needs export, it should be a parameter on one unified RAG action surface.
3. **Client-side ZIP.** Use a browser-compatible ZIP helper loaded as part of the chat webapp. Prefer a local vendored asset under `app/chat/webapp/` so export works without relying on a CDN at runtime.

## Milestones

Each milestone gets a review checkpoint before the next one starts.

### M1 — Read Surface + Client Helpers

**Goal:** prove the UI can read every document needed for export without server changes.

**Files:**
- `app/chat/webapp/index.html`
  - Add helper to page through all documents for a collection using the existing read operation.
  - Current UI already reads documents via `/v1/rag/collections/:id/documents?limit=100`; export must loop `offset`/`limit` until all `total` entries are read, not rely on the current visible 100-row panel.
  - Add helper to fetch individual document details only if the list endpoint does not already return `id`, `text`, `metadata`, and `createdAt` for each entry.
  - Add pure formatting helpers:
    - `safeExportName(id, used)`
    - `isDeprecatedEntry(doc)`
    - `exportableMetadata(doc)`
    - `formatEntryAsMd(doc)`
    - `formatEntryAsTxt(doc)`

**Rules:**
- Preserve document `text` exactly.
- Preserve metadata except internal `canonicalKey` when it equals `id`.
- Do not drop `chunkIndex` / `totalChunks`; they are useful provenance for uploaded chunks.
- Filter entries with `metadata.tags` containing `deprecated` or `superseded` unless `include_deprecated=true`.

**Review checkpoint:** read-all-documents strategy and metadata filtering.

### M2 — Browser ZIP + Download

**Goal:** the UI can build and download a ZIP Blob from documents already loaded in M1.

**Files:**
- `app/chat/webapp/index.html`
  - Add `buildCollectionZipBlob(docs, format, opts)` returning `{ blob, documentCount, fileCount }`.
  - Add client-side ZIP helper integration.
- Browser ZIP asset, path decided in implementation:
  - Prefer `app/chat/webapp/vendor/jszip.min.js` or equivalent local asset.
  - No server package or server route is required for ZIP generation.

**Behavior:**
- `md`: one `<safe(id)>.md` per exported document.
- `txt`: one `<safe(id)>.txt` per exported document plus `<safe(id)>.meta.json` when metadata remains after filtering.
- Filename collisions use `-1`, `-2`, ... suffix before extension.
- Outer ZIP filename: `<safe(collection)>-<YYYYMMDDTHHMMSSZ>.zip`.
- Soft cap: if export would exceed 10k documents or 50MB uncompressed, show a UI error and do not generate the ZIP.

**Review checkpoint:** ZIP file list, text preservation, collision behavior.

### M3 — Export Modal

**Goal:** user clicks Export on a collection row, picks options, and downloads the ZIP.

**Files:**
- `app/chat/webapp/index.html`
  - Add "Export" button to each collection row.
  - Add `<div id="export-modal">` sibling to `rag-modal`.
  - Add format radio (`md` default, `txt`).
  - Add "Include deprecated entries" checkbox (off default).
  - Add Cancel / Download buttons.
  - Download handler:
    1. read all documents for the selected collection;
    2. filter/format;
    3. build ZIP Blob;
    4. click object-URL `<a download>`;
    5. revoke the object URL.

**Out:** no changes to `srv/*`, no tool registration.

**Review checkpoint:** UI screenshot and manual export result.

### M4 — Docs + Smoke Test

**Files:**
- `docs/usage/FOR_USER.md`
  - Add short "Exporting a RAG collection" section with `md` vs `txt` trade-offs.
- `CHANGELOG.md`
  - Add entry under `Unreleased` or the next patch section, depending on release flow.

**Smoke test:**
- Open chat UI -> RAG modal -> Export -> md -> download -> `unzip -l` shows expected `.md` files.
- Repeat with `txt`; verify `.meta.json` sidecars appear only when metadata remains.
- Export a collection with IDs that collide after sanitization; verify no overwrites.
- Export with and without deprecated entries; verify filtering.
- Confirm `git diff -- srv` is empty for this feature.

## File Map

| Status | Path |
|---|---|
| Edit | `app/chat/webapp/index.html` |
| New/Edit | `app/chat/webapp/vendor/...` browser ZIP helper asset |
| Edit | `docs/usage/FOR_USER.md` |
| Edit | `CHANGELOG.md` |

## Risks / Double-Checks

1. **Exact read surface.** Confirm the existing UI-accessible RAG/MCP read operation returns enough fields for export. If it does not, use the existing per-document read operation; do not add a new server export route.
2. **Large collections.** Client-side ZIP generation is memory-bound. Keep the v1 soft cap and show a clear error.
3. **No server drift.** `srv/*` must stay untouched for this feature.
4. **No LLM choice conflict.** Do not add a standalone export tool to `TOOL_DEFS` or MCP protocol.
