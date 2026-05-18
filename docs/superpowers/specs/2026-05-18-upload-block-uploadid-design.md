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

### 1. UI: shared input-lock with ref-count

The existing `setInputEnabled(enabled)` (`index.html:776-779`) only toggles `#user-input` and `#send-btn`. The Send-cycle of `sendMessage()` already uses it: disable on submit, re-enable when the stream completes. `#attach-btn` is NOT covered, so today a user can click attach while the agent is processing.

The naive `setChatBusy(true)` / `setChatBusy(false)` pair would create a **reverse race**: user attaches during agent processing → upload `finally` re-enables Send before the agent finishes.

A `Set<reason>` ALSO doesn't ref-count if two code paths use the same reason string — `Set` dedupes silently, so the first `unlockInput('upload')` clears the only token while a second upload is still running. Two fixes are equivalent for our use case; we pick the one with smaller surface:

**Distinct reason strings, one per call site.** Every lock owner uses a unique reason — the Set then accurately models which owners are currently holding the lock.

```javascript
const inputLockReasons = new Set();

function lockInput(reason) {
  inputLockReasons.add(reason);
  applyInputLock();
}

function unlockInput(reason) {
  inputLockReasons.delete(reason);
  applyInputLock();
}

function applyInputLock() {
  const locked = inputLockReasons.size > 0;
  // Chat surface — always locked when any reason is present
  for (const id of ['user-input', 'send-btn', 'attach-btn']) {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  }
  // Manage Upload button follows the shared lock too, so chat processing,
  // bootstrap, or an upload from either entry point cannot overlap with a
  // second upload. Form fields stay governed by setManageFormBusy independently.
  const anyUpload =
    inputLockReasons.has('upload:quick') ||
    inputLockReasons.has('upload:manage');
  const manageBtn = document.querySelector('button[onclick="uploadFile()"]');
  if (manageBtn) manageBtn.disabled = anyUpload || locked;
}
```

Reason vocabulary (closed set — each used by exactly one site):

| reason | owner | acquired | released |
|---|---|---|---|
| `'bootstrap'` | initial page load | before models fetch | after dest list loads |
| `'chat-pending'` | `sendMessage()` | submit | stream end |
| `'upload:quick'` | `handleQuickFileAttach()` | enter `try` | `finally` |
| `'upload:manage'` | `uploadFile()` | enter `try` | `finally` |

Migration of existing call sites:

- `setInputEnabled(false)` in `sendMessage()` → `lockInput('chat-pending')`.
- `setInputEnabled(true)` after agent stream completes (around `index.html:889/896`) → `unlockInput('chat-pending')`.
- The bootstrap `setInputEnabled(false)` (waiting for models) → `lockInput('bootstrap')`; matching enable after dest list arrives → `unlockInput('bootstrap')`.

Overlap composition is now correct:

- chat-📎 starts (upload:quick) + Manage Upload starts (upload:manage) → Set has both → either's `finally` only removes its own token, the other keeps the lock alive. Chat input + Send + attach + Manage button stay disabled until BOTH uploads complete.
- chat-📎 starts + chat agent already busy (chat-pending) → both reasons present; upload `finally` removes only `'upload:quick'`, agent stream still owns `'chat-pending'`.
- Concurrent uploads (chat-📎 then Manage during it, or vice versa) — Manage button is disabled via `anyUpload` check, so the second one cannot be triggered from UI. The reason set still composes correctly if it ever does happen (e.g. via console).

`setInputEnabled` stays as a thin one-line wrapper for backward compat (or is removed entirely after migrating the two known consumers — preference: remove).

### 2. UI: block Manage upload form AND chat input

`app/chat/webapp/index.html:uploadFile`

Manage upload competes for the same embedder as chat (one user, same session). If we only lock the Manage form, the user can still hit Send → false-positive bug re-emerges. Manage upload must also hold the **shared** `inputLock` from section 1.

Two-part lock:

1. Manage-form fields (so the user can't restart the upload mid-flight):
   - `#rag-file-input`
   - The Upload button (`button[onclick="uploadFile()"]`)
   - `#rag-chunk-size`
   - `#rag-file-desc`
2. Shared chat lock (`lockInput('upload:manage')` / `unlockInput('upload:manage')`). The chat surface stays disabled until Manage upload completes; chat-📎 uses its own distinct `'upload:quick'` reason.

```javascript
function setManageFormBusy(busy) {
  const ids = ['rag-file-input', 'rag-chunk-size', 'rag-file-desc'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
  const btn = document.querySelector('button[onclick="uploadFile()"]');
  if (btn) btn.disabled = busy;
}

async function uploadFile() {
  // ... existing validation ...
  setManageFormBusy(true);
  lockInput('upload:manage');
  try {
    // existing upload flow ...
  } finally {
    setManageFormBusy(false);
    unlockInput('upload:manage');
  }
}
```

The `lockInput`/`unlockInput` calls use the **distinct** `'upload:manage'` reason; chat-📎 uses `'upload:quick'`. Concurrent uploads are blocked by the disabled upload entry points, and the reason-set still composes correctly if overlap ever happens through a non-UI path.

Status line is in focus during Manage upload — no alert needed (#93's red status on partial still fires).

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

Old return shape: `{ groups: Map<source, doc[]>, orphans, warningsBySource: Map<source, string[]> }`. Consumers iterated the Map and used the **map key as the source filename**. That breaks once the key becomes a composite — `safeSourceExportName("rap-bo-creation.md|8f2c1a30")` would put the literal composite into the zip path.

New return shape — explicit value object per group:

```javascript
{
  groups: Map<groupKey, { source, uploadId, docs, warnings }>,
  orphans: doc[],
}
```

`warningsBySource` is folded into the group object (one warning array per upload group). The map key is internal/opaque; the `source` and `uploadId` come from the value.

`groupKey(metadata)` helper, **exported** so consumers in `index.html` can compute the same key for lookups:

```javascript
function groupKey(metadata) {
  const source = metadata && metadata.source;
  if (!source) return null; // orphan
  const uploadId = (metadata && metadata.uploadId) || '_legacy';
  // JSON-encode the pair so a `|` (or any other char) inside the source
  // filename can't create a collision with a different (source, uploadId).
  // metadata.source is the original filename, NOT slugified, so we can't
  // assume it's safe for a string separator.
  return JSON.stringify([source, uploadId]);
}
```

The encoded form (`'["foo|bar.md","8f2c1a30"]'`) is opaque, unambiguous, and never reaches user-visible text — the renderer always derives `source` from the group value.

`RagExport` now exports `groupKey` alongside `groupChunksBySource`, `safeSourceExportName`, `reassembleSource`.

Consumer migration (within `index.html`):

- Bulk export loop in `buildCollectionZipBlob` — also rebuild the aggregate warning map for the existing status renderer (see "Bulk export return shape" below):

  ```javascript
  const { groups, orphans } = RagExport.groupChunksBySource(docs);
  const warningsBySource = new Map(); // keyed by groupKey for the UI renderer
  const used = new Set();
  for (const [key, { source, uploadId, docs: groupDocs, warnings }] of groups.entries()) {
    const safeName = RagExport.safeSourceExportName(source, used);
    const { name, body, sidecar } = RagExport.reassembleSource(
      groupDocs, safeName, uploadId, warnings,
    );
    if (warnings && warnings.length) warningsBySource.set(key, warnings);
    // zip.file(...) as before
  }
  // include warningsBySource in the returned shape
  ```

- Per-entry `downloadSourceFile`:

  ```javascript
  const key = RagExport.groupKey(clicked.metadata);
  const group = groups.get(key);
  if (!group) { ... }
  const { source, uploadId, docs: groupDocs, warnings } = group;
  // ...
  ```

Map keys never escape into user-visible text. The `source` value (raw filename) is what reaches `safeSourceExportName`, the warning strings, and the sidecar.

#### Bulk export return shape

`buildCollectionZipBlob`'s public return shape is unchanged from #89 — `{ blob, documentCount, fileCount, sourceFileCount, orphanCount, chunkCount, warningsBySource, includedChunks, includedReassembled }`. The `warningsBySource` Map keyed by the new composite `groupKey` keeps `runCollectionExport`'s existing flatten-and-render path (`for (const ws of warningsBySource.values()) for (const w of ws) flat.push(w)`) working unchanged — the renderer never read the key anyway, only the values. No new fields needed in the result.

Sidecar adds `uploadId`:

```json
{
  "source": "rap-bo-creation.md",
  "exportName": "rap-bo-creation.md",
  "uploadId": "8f2c1a30-...",
  ...
}
```

Multiple uploads of the same filename → multiple sidecars with different `uploadId`s. The `safeSourceExportName` collision suffix (`-1`, `-2`, ...) already handles same-sanitized-name conflicts within the export, so the second upload's reassembled body lands at `rap-bo-creation-1.md` automatically. `reassembleSource` gains a 4th positional arg `uploadId` (string or undefined for legacy); the sidecar omits the field when undefined.

Backward compatibility: existing entries without `metadata.uploadId` get the `_legacy` token in the composite key. Old collections still reassemble correctly — all pre-fix chunks of one source group under one `(source, '_legacy')` entry. Sidecar's `uploadId` field is omitted in that case so the marker doesn't leak into provenance.

### 5. Client: per-entry SRC button uses uploadId

`downloadSourceFile(collection, docId)` currently does `groups.get(sourceName)`. After the new return shape it uses the exported `RagExport.groupKey` helper:

```javascript
const key = RagExport.groupKey(clicked.metadata);
const group = groups.get(key);
if (!group) {
  alert('No active group found for this entry.');
  return;
}
const { source, uploadId, docs, warnings } = group;
const safeName = RagExport.safeSourceExportName(source, new Set());
const { name, body, sidecar } = RagExport.reassembleSource(
  docs, safeName, uploadId, warnings,
);
// build mini-zip as before
```

User clicking SRC on a chunk of upload-A only reassembles that upload's chunks, not chunks from another upload of the same source.

## Error handling

| Condition | Behavior |
|---|---|
| Upload starts (chat-📎) | `lockInput('upload:quick')` disables `#user-input` + Send + attach via the shared reason-set lock |
| Upload starts (Manage) | `setManageFormBusy(true)` disables Manage form fields; `lockInput('upload:manage')` additionally locks the shared chat surface |
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
- `app/chat/webapp/index.html` — new `lockInput` / `unlockInput` / `applyInputLock` shared lock; `setManageFormBusy` helper for Manage-form-only fields; migrate `setInputEnabled` call sites (`sendMessage` chat-pending lock, bootstrap lock) to the new API; `try/finally` around both upload paths.
- `app/chat/webapp/rag-export.js` — composite groupKey, sidecar field, backward-compat `_legacy` token.
- `test/unit/rag-export.test.ts` — uploadId grouping tests and reassembly sidecar field tests.

## Open questions

None. UploadId format (`uuid` short-prefixed into the id, full in metadata) chosen for readability + correct disambiguation. `_legacy` token chosen because UUIDs can't start with `_` so it can't collide.
