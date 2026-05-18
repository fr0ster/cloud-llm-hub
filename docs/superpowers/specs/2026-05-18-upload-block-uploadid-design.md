# Upload UI blocking + uploadId disambiguator

**Date:** 2026-05-18
**Issue:** [cloud-llm-hub#94](https://github.com/fr0ster/cloud-llm-hub/issues/94)
**Scope:** Two coordinated fixes (1 client-UX, 1 server+client data model) in a single PR shipping as v6.8.2.

## TL;DR

After v6.8.1 the upload path preserves data on Qdrant/embedder failure, but two false-positive bug classes remain:

1. **UI not blocked during upload** → user fires parallel chat-request → embedder gets two concurrent streams → some chunks rate-limited → user sees `(M/N chunks)` red and reports "incomplete export" when the real cause is the user's own concurrency.
2. **Repeat upload of same filename silently overwrites** → `doc.id` derived from filename only → second upload's chunks share ids with first → in-memory map collision → user-visible "one record" when expected "two records".

Fix:

- Block `#user-input`, Send button, `#attach-btn`, and the Manage Upload form during upload. Re-enable in a `finally` block so error paths still recover.
- Generate a per-upload `uploadId = crypto.randomUUID()` server-side; embed it in `doc.id` and `metadata.uploadId`. Update `groupChunksBySource` (client-side) to group by `(source, uploadId)` so two uploads of the same filename produce two reassembled files.

No new endpoints, no schema migrations.

## What's already in place

- `app/chat/webapp/index.html:1455+` — `handleQuickFileAttach` (chat-📎 path). Pushes to `attachedFiles[]`, renders the bar.
- `app/chat/webapp/index.html:1720+` — Manage panel `uploadFile` function.
- `srv/rag-handler.ts:425+` — `POST /v1/rag/collections/:id/upload` handler. Constructs `doc.id` via `slugify(filename)-chunk-NNN`.
- `app/chat/webapp/rag-export.js` — `groupChunksBySource(docs)` keys on `metadata.source`.

## Out of scope

- Incremental upload progress (streaming/SSE). Upload is one HTTP request; status updates only on completion.
- Background reindex job for `unindexed:true` chunks.
- Source-grouped UI rework with drill-down to see all chunks (#92 part B, deferred behind SearchSource timeout work).
- Server-side embedder queue / serialize across users.

## Components

### 1. UI: block chat-📎 upload

`app/chat/webapp/index.html:handleQuickFileAttach`

At the moment the user accepts the description prompt (just before the first `ragFetch`), disable:

- `document.getElementById('user-input')`
- `document.getElementById('send-btn')` (or whatever the Send button id is — confirm via `grep -n 'id="send' index.html`)
- `document.getElementById('attach-btn')`

Track this with a small helper:

```javascript
function setChatBusy(busy) {
  const ids = ['user-input', 'send-btn', 'attach-btn'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
}
```

Wrap the upload work in `try / finally`:

```javascript
async function handleQuickFileAttach(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';
  const description = prompt(...);
  if (description === null) return;

  setChatBusy(true);
  try {
    // existing upload flow ...
  } finally {
    setChatBusy(false);
  }
}
```

Idempotency: if `setChatBusy(true)` runs twice (impossible today because we just blocked the input, but defensive), both re-enables still leave the page usable.

### 2. UI: block Manage upload form

`app/chat/webapp/index.html:uploadFile`

Disable:

- The file-input (`#rag-file-input`)
- The Upload button (search by handler `onclick="uploadFile()"`)
- The chunk-size input (`#rag-chunk-size`)
- The description input (`#rag-file-desc`)

Same `try/finally` pattern. Status line is already in focus — no alert needed.

```javascript
function setManageUploadBusy(busy) {
  const ids = ['rag-file-input', 'rag-chunk-size', 'rag-file-desc'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
  // Find the upload button — only one with onclick="uploadFile()"
  const btn = document.querySelector('button[onclick="uploadFile()"]');
  if (btn) btn.disabled = busy;
}
```

### 3. Server: uploadId in doc.id and metadata

`srv/rag-handler.ts:POST /v1/rag/collections/:id/upload`

```ts
const uploadId = crypto.randomUUID();
const uploadIdShort = uploadId.slice(0, 8);

const docs = chunks.map((text, i) => ({
  id: `${slugify(name)}-${uploadIdShort}-chunk-${String(i + 1).padStart(3, '0')}`,
  text,
  metadata: {
    source: name,
    uploadId,
    description: description || undefined,
    chunkIndex: i,
    totalChunks: chunks.length,
  },
}));
```

`uploadIdShort` in the id keeps it readable; full `uploadId` lives in metadata for grouping.

The response shape (`{ filename, chunks, added, errors }`) stays unchanged — client UI doesn't need uploadId to render status. Reassembly uses metadata directly.

### 4. Client: groupChunksBySource keyed by (source, uploadId)

`app/chat/webapp/rag-export.js`

Change the grouping map key to a composite. Internal Map keys can be strings; pick a simple separator that can't appear in either side:

```javascript
function groupKey(metadata) {
  const source = metadata && metadata.source;
  if (!source) return null; // orphan
  const uploadId = (metadata && metadata.uploadId) || '_legacy';
  return source + '|' + uploadId;
}
```

(`|` is safe — filenames are sanitized; UUIDs and `_legacy` don't contain it.)

Change the `groups` and `warningsBySource` Maps to use this composite key. The Map still exposes `source` for messages and sidecar, but disambiguates uploads.

Sidecar adds `uploadId`:

```json
{
  "source": "rap-bo-creation.md",
  "exportName": "rap-bo-creation.md",
  "uploadId": "8f2c1a30-...",
  ...
}
```

Multiple uploads of the same filename → multiple sidecars with different `uploadId`s. The `safeSourceExportName` collision logic (`-1`, `-2`, ...) already handles two files with the same sanitized name in the zip, so the second upload's reassembled output lands at `rap-bo-creation-1.md` automatically. Spec change: pass uploadId to the reassembler so the warning messages reference the right upload (no behaviour change otherwise — collision suffix is what disambiguates filenames).

Backward compatibility: existing entries without `metadata.uploadId` get the `_legacy` token. Old collections still reassemble correctly; all pre-fix chunks of the same source group together under one `_legacy` group.

### 5. Client: per-entry SRC button uses uploadId

`downloadSourceFile(collection, docId)` already filters `groups.get(sourceName)`. Update to use the composite key from the clicked doc:

```javascript
const sourceKey = groupKey(clicked.metadata);
const group = groups.get(sourceKey);
```

User clicking SRC on a chunk of upload-A only reassembles that upload's chunks, not chunks from another upload of the same source.

## Error handling

| Condition | Behavior |
|---|---|
| Upload starts | UI elements disabled via `setChatBusy(true)` or `setManageUploadBusy(true)` |
| Upload returns 2xx with `added === chunks` | UI re-enabled, green status, no alert |
| Upload returns 2xx with `added < chunks` (v6.8.1 path) | UI re-enabled, red status with `(M/N chunks)`, alert (chat-📎) |
| Upload throws / network error | UI re-enabled in `finally`, red status with error message |
| User refreshes during upload | Browser default — no in-flight resume. Stale state cleared by reload. |
| Same filename uploaded twice in the same session | Two separate `uploadId`s, two doc-id sets, two groups in export |
| Legacy entry (pre-uploadId, no metadata.uploadId) | Groups under `_legacy` token |

## Testing

**Unit (`test/unit/rag-export.test.ts`):**

- `groupChunksBySource`:
  - Two uploads of the same source with different uploadIds → two groups, each fully reassembled.
  - Mix of uploadId-stamped and legacy (no uploadId) → uploadId entries grouped per-upload, legacy entries grouped under `_legacy` per source.
- `reassembleSource`:
  - Sidecar contains `uploadId` field when group has it.
  - Sidecar `uploadId` field is undefined (or omitted) for legacy groups.

**Manual (post-deploy):**

- Chat-📎 upload: verify `#user-input`, Send, and attach button are visibly disabled during upload. Try clicking Send → no effect. Re-enabled after upload returns.
- Manage upload: same for file-input, Upload button, chunk-size, description.
- Upload same file twice via chat-📎 → Manage panel shows two distinct doc-id prefixes for the same `source` value.
- Bulk export → ZIP contains both reassembled files (`rap-bo-creation.md` and `rap-bo-creation-1.md`).
- Click SRC on a chunk of the second upload → mini-zip contains that upload's body, not a merge.
- Upload a legacy collection (any collection populated before this PR) → reassembly still works; sidecar has no `uploadId` field.

## File touch list

- `srv/rag-handler.ts` — `uploadId` generation + metadata stamping in the upload handler.
- `app/chat/webapp/index.html` — `setChatBusy` / `setManageUploadBusy` helpers + `try/finally` around upload paths.
- `app/chat/webapp/rag-export.js` — composite groupKey, sidecar field, backward-compat `_legacy` token.
- `test/unit/rag-export.test.ts` — uploadId grouping tests and reassembly sidecar field tests.

## Open questions

None. UploadId format (`uuid` short-prefixed into the id, full in metadata) chosen for readability + correct disambiguation. `_legacy` token chosen because UUIDs can't start with `_` so it can't collide.
