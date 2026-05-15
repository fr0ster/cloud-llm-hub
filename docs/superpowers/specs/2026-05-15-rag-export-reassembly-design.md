# RAG export — reassemble chunked source files

**Date:** 2026-05-15
**Issue:** [cloud-llm-hub#88](https://github.com/fr0ster/cloud-llm-hub/issues/88)
**Scope:** Client-side (no server changes)

## TL;DR

Files uploaded into RAG collections are split into many small chunks at ingest. Today's export gives you back those chunks one-per-file in a zip — round-trip editing requires manual concatenation. This design adds a **reassembly layer** in the existing browser-side export path:

- Bulk export zip gets a second folder `reassembled/` next to the existing `chunks/` (both included by default, both toggleable).
- Each RAG entry row gets a second download button `⬇ source` next to the existing `⬇ chunk`, visible only when the entry came from a chunked upload.
- Both paths share one helper (`groupChunksBySource` + `reassembleSource`).
- No server endpoints, no metadata schema changes — the metadata needed for grouping is already stamped at upload (`source`, `chunkIndex`, `totalChunks`).

## What's already in place

`POST /v1/rag/collections/:id/upload` (`srv/rag-handler.ts:400`) stamps every chunk with:

```
metadata: {
  source: <filename>,         // e.g. "rap-bo-creation.md"
  description: <opt>,         // user-supplied at upload
  chunkIndex: 0..N-1,         // 0-based
  totalChunks: N
}
```

Chunks are produced by `splitTextIntoChunks` (`srv/rag-handler.ts:40`) — paragraph-based split on `\n\n` boundaries with sentence-level fallback for oversized paragraphs. **There is no overlap window** — chunks are disjoint, so reassembly is a plain ordered concatenation. No overlap-trim logic needed.

Entries added via `rag_add` (MCP tool) carry no `source` / `chunkIndex` — they are standalone records ("orphans" below).

## Out of scope

- Server-side streaming export. Caps stay client-side (`EXPORT_MAX_DOCS=10000`, soft size limit).
- Lossless whitespace recovery. The splitter `.trim()`s each chunk; reassembly joins with `\n\n`. Files with non-standard whitespace patterns (multi-blank-line runs, trailing whitespace) won't round-trip byte-identical.
- Changing the upload-side splitter or its metadata.
- `rag_correct` / `rag_deprecate` integration with reassembled-file identifiers. The `reassembledFrom` front-matter field is written for future use, but consuming it on re-upload is a separate spec.

## Components

### `groupChunksBySource(docs) → { groups, orphans }`

Pure function over the document list returned by `fetchAllDocuments`.

```
input:   docs[] — each with .id, .text, .metadata, .createdAt
output:
  groups:  Map<sourceName, sortedChunks[]>   // chunked uploads only
  orphans: doc[]                              // no source/chunkIndex
```

Algorithm:

```
for each doc:
  if doc.metadata.source && Number.isInteger(doc.metadata.chunkIndex):
    groups[doc.metadata.source].push(doc)
  else:
    orphans.push(doc)

for each group:
  sort by chunkIndex ascending

sanity-check warnings (collected, surfaced in UI status — non-fatal):
  - chunkIndex must be contiguous 0..N-1 — else "⚠ <source>: N chunks missing (indices ...)"
  - all chunks in a group must agree on totalChunks — else "⚠ <source>: inconsistent totalChunks (A vs B)"
```

### `reassembleSource(group) → { name, body, sidecar? }`

Pure function, no I/O. Output format is derived from the source filename's extension (no `format` parameter — the format radio in the modal applies only to the `chunks/` folder).

```
joined     = group.map(d => d.text).join('\n\n')
sourceName = group[0].metadata.source        // includes original extension
ext        = sourceName.toLowerCase().endsWith('.txt') ? '.txt' : '.md'
```

Format rules:

| Original ext | Output |
|---|---|
| `.md` (or unknown) | one `.md` file with optional YAML front-matter (see below) |
| `.txt` | one `.txt` file with sidecar `<source>.meta.json` |

Front-matter for `.md` is written only when at least one of `description` / `totalChunks` is present:

```yaml
---
source: rap-bo-creation.md
description: <if present>
totalChunks: <N>
reassembledFrom: [<chunk id 1>, <chunk id 2>, ...]
createdAt: <min of chunk createdAts>
---

<joined body>
```

`reassembledFrom` is a marker for a future re-upload flow that wants to replace existing chunks. Out of scope for this spec, but the field is written so the data is there.

### `buildCollectionZipBlob` — adapted

Existing function in `app/chat/webapp/index.html:1952`. Changes:

```
input:  docs, format, opts
opts:
  include_deprecated: bool   (existing)
  include_reassembled: bool  (new, default true)
  include_chunks: bool       (new, default true)

output: { blob, documentCount, fileCount, sourceFileCount, orphanCount }
```

Build steps:

```
filtered = filter by deprecated tag (existing)
{ groups, orphans } = groupChunksBySource(filtered)

zip = new JSZip()

if opts.include_reassembled:
  for each group:
    { name, body, sidecar? } = reassembleSource(group)
    zip.file('reassembled/' + name, body)
    if sidecar: zip.file('reassembled/' + sidecar.name, sidecar.body)

if opts.include_chunks:
  for each doc in filtered:                  // current per-chunk path
    for each part in formatter(doc):         // existing formatter
      zip.file('chunks/' + safeExportName(doc.id, used) + part.ext, part.body)

return { blob, documentCount, fileCount, sourceFileCount, orphanCount }
```

Caps are applied across the whole zip (`EXPORT_MAX_UNCOMPRESSED_BYTES` counts both folders). If a single reassembled file already crosses the cap, the export aborts — same behavior as current.

### Export modal

Existing controls preserved (`Format` radio md/txt, `Include deprecated` checkbox). Added:

```
☑ Include reassembled files  (default on)
☑ Include raw chunks         (default on)
```

If both off → Download button disabled with tooltip `"Pick at least one of reassembled / chunks"`.

Status message after a successful export:

```
Exported {sourceFileCount} source files (reassembled/), {chunkCount} chunks (chunks/), {orphanCount} orphans → {filename}
```

### Per-entry buttons

Current row:

```html
<button title="Download this chunk">⬇ chunk</button>
```

New layout:

```html
<button title="Download this chunk">⬇ chunk</button>
<button title="Reassemble and download the whole source file"
        data-doc-id="..." style="display: <conditional>">
  ⬇ source
</button>
```

`⬇ source` is **rendered only when** `doc.metadata.source && Number.isInteger(doc.metadata.chunkIndex)`. Click handler:

```
1. fetchAllDocuments(collectionId)   // existing pager-by-200
2. group = filter by metadata.source === doc.metadata.source
3. reassembleSource(group)
4. downloadBlob(...)                  // existing helper
```

Edge case: if after filtering `group.length === 1` (this entry is its own source), still produce the reassembled file (same as a 1-chunk source). Toast: `"This entry is the only chunk for <source>."`

## Error handling

Surfaced in the existing modal status line (bulk) or as a toast (per-entry):

| Condition | Behavior |
|---|---|
| Missing chunk indices in a group | Continue with what's there + ⚠ warning per source |
| Inconsistent `totalChunks` across a group | Continue + ⚠ warning per source |
| Both `include_reassembled` and `include_chunks` off | Button disabled |
| Single reassembled file exceeds `EXPORT_MAX_UNCOMPRESSED_BYTES` | Abort with existing "Collection too large" error |
| Per-entry button on an orphan | Button not rendered — no error path |

## Testing

**Unit (browser via Jest with jsdom):**

- `groupChunksBySource`:
  - all chunked (one source) → 1 group, 0 orphans
  - multiple sources interleaved → groups per source
  - mixed chunked + rag_add → groups + orphans split correctly
  - missing chunkIndex on some → those go to orphans
  - gap in indices (0,1,3) → group present, warning surfaced separately
- `reassembleSource`:
  - md with description → front-matter populated
  - md without description → body only, no front-matter
  - txt → body + sidecar with same metadata content
  - empty group → throws (caller should not reach this)

**Manual:**

- Upload `tutorials/rap-bo-creation.md` (real chunked file) → export → diff `reassembled/rap-bo-creation.md` against original (modulo `.trim()` whitespace).
- Add a single entry via `rag_add` to the same collection → verify it lands in `chunks/` only.
- Toggle off `Include chunks` → only `reassembled/` in zip.
- Click `⬇ source` on a chunk → file matches the corresponding bulk reassembly.

## File touch list

- `app/chat/webapp/index.html` — add helpers `groupChunksBySource`, `reassembleSource`, two checkboxes in export modal, second per-entry button, wire-up in `buildCollectionZipBlob` and a new `downloadSourceFile(doc)` function.
- `test/unit/` — new unit tests for the two helpers. Current export code lives inline in `index.html`; implementation may extract helpers to a small module (e.g. `app/chat/webapp/rag-export.js`) to make them testable, or test through a thin shim — implementation plan decides.

## Open questions

None. Format selection, orphan handling, button layout, and architecture all settled in brainstorming.
