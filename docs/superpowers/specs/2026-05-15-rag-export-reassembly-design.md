# RAG export — reassemble chunked source files

**Date:** 2026-05-15
**Issue:** [cloud-llm-hub#88](https://github.com/fr0ster/cloud-llm-hub/issues/88)
**Scope:** Client-side (no server changes)

## TL;DR

Files uploaded into RAG collections are split into many small chunks at ingest. Today's export gives you back those chunks one-per-file in a zip — round-trip editing requires manual concatenation. This design adds a **reassembly layer** in the existing browser-side export path:

- Bulk export zip gets a second folder `reassembled/` next to the existing `chunks/` (both included by default, both toggleable).
- Each RAG entry row gets a second download button `⬇ source` next to the existing `⬇ chunk`, visible only when the entry came from a chunked upload.
- Both paths share one helper (`groupChunksBySource` + `reassembleSource`).
- Reassembled files contain source text only; provenance is written to sidecar metadata so re-upload does not ingest export headers.
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
- `rag_correct` / `rag_deprecate` integration with reassembled-file identifiers. The `reassembledFrom` sidecar field is written for future use, but consuming it on re-upload is a separate spec.

## Components

### `groupChunksBySource(docs) → { groups, orphans, warnings }`

Pure function over the document list returned by `fetchAllDocuments`.

```
input:   docs[] — each with .id, .text, .metadata, .createdAt
output:
  groups:   Map<sourceName, sortedChunks[]>  // chunked uploads only
  orphans:  doc[]                             // no source/chunkIndex
  warnings: string[]                          // non-fatal integrity issues
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
  - duplicate chunkIndex values — else "⚠ <source>: duplicate chunk index <N>"
  - group length must match declared totalChunks when totalChunks is consistent — else "⚠ <source>: expected N chunks, found M"
```

Grouping by `source` is intentionally best-effort because current upload metadata does not include an upload batch id. The warnings above are required to make likely mixed-version groups visible (for example, re-uploading the same filename with fewer chunks can leave stale higher-index chunks in a collection).

### `safeSourceExportName(sourceName, used) → safeName`

Pure function. Produces the filename used under `reassembled/`.

Rules:

- Treat `metadata.source` as untrusted input.
- Strip directory components (`foo/bar.md` and `../bar.md` both become `bar.md`).
- Replace characters outside `[A-Za-z0-9._-]` with `_`.
- Preserve the original extension when present.
- Truncate the basename to keep the full filename within the same practical limit as `safeExportName`.
- Disambiguate collisions with `-1`, `-2`, ... before the extension.
- Fall back to `source.txt` when the sanitized name is empty.

### `reassembleSource(group, safeName) → { name, body, sidecar }`

Pure function, no I/O. Output extension is the sanitized original extension from `safeName`. The `format` radio in the modal applies only to the `chunks/` folder.

```
joined     = group.map(d => d.text).join('\n\n')
sourceName = group[0].metadata.source        // includes original extension
name       = safeName                         // sanitized basename, extension preserved
```

Format rules:

| Output file | Contents |
|---|---|
| `reassembled/<safe original basename>` | source text only: `joined` |
| `reassembled/<safe original basename>.meta.json` | provenance sidecar |

Reassembled source files never receive YAML front-matter by default. This keeps the file suitable for editing and re-upload without ingesting export metadata as RAG content.

Sidecar shape:

```json
{
  "source": "rap-bo-creation.md",
  "exportName": "rap-bo-creation.md",
  "description": "<if present>",
  "totalChunks": 12,
  "reassembledFrom": ["<chunk id 1>", "<chunk id 2>"],
  "createdAt": "<min of chunk createdAts>",
  "warnings": ["<group warning strings for this source>"]
}
```

`reassembledFrom` is a marker for a future re-upload flow that wants to replace existing chunks. Out of scope for this spec, but the field is written in the sidecar so the data is there without polluting the source body.

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
{ groups, orphans, warnings } = groupChunksBySource(filtered)

zip = new JSZip()

if opts.include_reassembled:
  usedSourceNames = new Set()
  for each group:
    safeName = safeSourceExportName(group[0].metadata.source, usedSourceNames)
    { name, body, sidecar } = reassembleSource(group, safeName)
    zip.file('reassembled/' + name, body)
    zip.file('reassembled/' + sidecar.name, sidecar.body)

if opts.include_chunks:
  usedChunkNames = new Set()
  for each doc in filtered:                  // current per-chunk path
    for each part in formatter(doc):         // existing formatter
      zip.file('chunks/' + safeExportName(doc.id, usedChunkNames) + part.ext, part.body)

return { blob, documentCount, fileCount, sourceFileCount, orphanCount, chunkCount, warnings }
```

**Cap accounting.** `EXPORT_MAX_UNCOMPRESSED_BYTES` counts every text payload written to the zip: `chunks/`, `reassembled/`, and `.meta.json` sidecars. This preserves the existing meaning of the cap as a browser-memory guard for the actual archive being built.

Because the default export now includes both `chunks/` and `reassembled/`, some collections near the existing cap may exceed it. The error should name the selected folders and suggest reducing the export surface:

```
Collection too large for selected export contents. Try disabling raw chunks or reassembled files.
```

When only `include_chunks` is selected, behavior remains equivalent to the current exporter.

### Export modal

Existing controls preserved (`Format` radio md/txt, `Include deprecated` checkbox). Added:

```
☑ Include reassembled files  (default on)
☑ Include raw chunks         (default on)
```

If both off → Download button disabled with tooltip `"Pick at least one of reassembled / chunks"`.

Status message after a successful export:

```
Exported {sourceFileCount} source files (reassembled/), {chunkCount} chunks (chunks/, including {orphanCount} orphans) → {filename}
```

If `include_chunks` is off, orphans are not exported and the status must say so:

```
Exported {sourceFileCount} source files (reassembled/), skipped {orphanCount} orphans because raw chunks are disabled → {filename}
```

If warnings are present, append a compact warning summary in the existing status line and expose the full warning list in the same UI area (for example as newline text or a collapsible details block).

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
2. apply the same deprecated/superseded filtering policy as the default bulk export
3. { groups, warnings } = groupChunksBySource(filteredDocs)
4. group = groups.get(doc.metadata.source)
5. safeName = safeSourceExportName(doc.metadata.source, new Set())
6. reassembleSource(group, safeName)
7. build a mini zip containing:
   - <name>
   - <name>.meta.json
8. downloadBlob(...)                  // existing helper
```

Edge case: if after filtering `group.length === 1` (this entry is its own source), still produce the reassembled file (same as a 1-chunk source). Toast: `"This entry is the only chunk for <source>."`

Per-entry `⬇ source` should match the default bulk export result for the same source, including the sidecar. It downloads a small zip named `<safeBasename>.zip` (basename of `safeName` without the original extension) so the source body and provenance stay together. It excludes deprecated/superseded chunks by default; if the clicked row is excluded by that policy or no group remains after filtering, show a toast explaining that the source is deprecated/superseded and use raw `⬇ chunk` for that record.

## Error handling

Surfaced in the existing modal status line (bulk) or as a toast (per-entry):

| Condition | Behavior |
|---|---|
| Missing chunk indices in a group | Continue with what's there + ⚠ warning per source |
| Inconsistent `totalChunks` across a group | Continue + ⚠ warning per source |
| Duplicate `chunkIndex` values in a group | Continue using stable sort order + ⚠ warning per source |
| Group length differs from consistent `totalChunks` | Continue + ⚠ warning per source |
| Unsafe or duplicate source filenames | Sanitize and disambiguate before writing to zip |
| Both `include_reassembled` and `include_chunks` off | Button disabled |
| Selected export contents exceed `EXPORT_MAX_UNCOMPRESSED_BYTES` | Abort with "Collection too large for selected export contents"; suggest disabling raw chunks or reassembled files |
| Per-entry button on an orphan | Button not rendered — no error path |

## Testing

**Unit (browser via Jest with jsdom):**

- `groupChunksBySource`:
  - all chunked (one source) → 1 group, 0 orphans
  - multiple sources interleaved → groups per source
  - mixed chunked + rag_add → groups + orphans split correctly
  - missing chunkIndex on some → those go to orphans
  - gap in indices (0,1,3) → group present, warning surfaced separately
  - duplicate chunkIndex → group present, warning surfaced separately
  - consistent totalChunks mismatch with group length → warning surfaced separately
- `safeSourceExportName`:
  - strips path components from `../nested/source.md`
  - preserves extensions for `.json`, `.xml`, `.csv`, `.abap`, `.md`, `.txt`
  - disambiguates two sources with the same sanitized basename
- `reassembleSource`:
  - md with description → source body only, metadata sidecar populated
  - md without description → source body only, metadata sidecar still includes provenance
  - txt/json/xml/csv/abap → preserves sanitized original extension + sidecar
  - empty group → throws (caller should not reach this)

**Manual:**

- Upload `tutorials/rap-bo-creation.md` (real chunked file) → export → diff `reassembled/rap-bo-creation.md` against original (modulo `.trim()` whitespace and `\n\n` join behavior). Verify metadata is only in `reassembled/rap-bo-creation.md.meta.json`.
- Add a single entry via `rag_add` to the same collection → verify it lands in `chunks/` only.
- Toggle off `Include chunks` → only `reassembled/` in zip.
- Toggle off `Include chunks` with an orphan present → orphan is skipped and status says it was skipped.
- Click `⬇ source` on a chunk → mini zip contains the source file and `.meta.json`; source body matches the corresponding bulk reassembly.
- Upload a file with a path-like or unsafe filename → verify `reassembled/` uses a sanitized basename and cannot create unexpected zip paths.

## File touch list

- `app/chat/webapp/index.html` — add helpers `groupChunksBySource`, `safeSourceExportName`, `reassembleSource`, two checkboxes in export modal, second per-entry button, wire-up in `buildCollectionZipBlob` and a new `downloadSourceFile(doc)` function.
- `test/unit/` — new unit tests for the two helpers. Current export code lives inline in `index.html`; implementation may extract helpers to a small module (e.g. `app/chat/webapp/rag-export.js`) to make them testable, or test through a thin shim — implementation plan decides.

## Open questions

None. Format selection, orphan handling, button layout, and architecture all settled in brainstorming.
