# RAG upload reliability — retry, logging, chat-📎 feedback

**Date:** 2026-05-17
**Issue:** [cloud-llm-hub#90](https://github.com/fr0ster/cloud-llm-hub/issues/90)
**Scope:** Three coordinated fixes (1 server-logic, 1 server-observability, 1 client-UX) in a single PR.

## TL;DR

`addDocumentsBulk` silently drops chunks when the embedder returns transient errors. The current write path also treats `IRag` write failures as success because `stored.rag.upsert(...)` returns a `Result` (`{ ok: false, error }`) for many backend failures instead of throwing, and `addDocument` does not inspect that result before persisting the document and incrementing `added`. The chat-📎 upload path is the most visible victim because it runs concurrently with active chat sessions (AI Core embedder under load), and its UI also hides the loss by showing only the splitter's `chunks` count instead of the server's `added` count. Fix:

1. **Honor RAG write failures** in `addDocument`: check the `upsert` `Result`, throw on `!ok`, and persist only after a successful RAG write.
2. **Retry transient errors** in `addDocumentsBulk` with `[200ms, 500ms, 1500ms]` backoff before declaring a chunk failed.
3. **Log a warn line** when `added < docs.length` so the failure is visible in logs even when callers swallow the response body.
4. **Surface `added/chunks` parity** in the chat-📎 attached-files bar, and flag the row red with a one-line toast when `added < chunks`.

No metadata schema changes, no new endpoints.

## What's already in place

- `srv/rag-collections.ts:381` — `addDocument` awaits `stored.rag.upsert(...)` but does not inspect the returned `Result`; a backend `{ ok: false }` can still be persisted and counted as added.
- `srv/rag-collections.ts:395` — `addDocumentsBulk` loops chunks serially, catches thrown errors into a string array, returns `{ added, errors }`. No retry.
- `srv/rag-handler.ts:459` — upload handler returns `{ filename, chunks, added, errors }` to the client.
- `app/chat/webapp/index.html:1741` — Manage `uploadFile` status: `Uploaded: N chunks, M added`. Correct.
- `app/chat/webapp/index.html:1484` — chat-📎 `handleQuickFileAttach` status: only `data.chunks`, no `added`. Misleading on partial success.

## Out of scope

- Concurrent / pipelined embedder calls. Serial dispatch with retry is enough for current load and avoids new rate-limit landmines.
- Raising the doc-list `?limit=100` cap or adding pagination — separate UX concern; export already pages correctly via `fetchAllDocuments`.
- Retrying the *first* attempt: only failed chunks retry, not all chunks.
- Resuming partial uploads across HTTP requests. One bulk call = one terminal answer.

## Components

### 1. Server: make `addDocument` fail on RAG write failure

`srv/rag-collections.ts` — change `addDocument` so the document is persisted only after the RAG store confirms the write:

```ts
const result = await stored.rag.upsert(doc.text, {
  id: `doc:${collectionId}:${doc.id}`,
  namespace:
    namespace ??
    (stored.meta.scope === 'global' ? 'global' : stored.meta.owner),
  ...doc.metadata,
});

if (!result.ok) {
  throw result.error;
}

stored.documents.set(doc.id, full);
stored.meta.documentCount = stored.documents.size;
this.persistDocument(collectionId, full);
return full;
```

This is required for the retry loop below to see vector/embedder failures. Without it, `addDocumentsBulk` can still report `added === docs.length` even when the vector backend rejected a chunk.

### 2. Server: `addDocumentsBulk` with retry

`srv/rag-collections.ts` — change the loop in `addDocumentsBulk` to:

```
for each doc:
  result = await tryWithRetry(() => addDocument(...))
  if result.ok:    added++; throttle every 10
  else:            errors.push(`${doc.id}: ${result.error.message}`)
```

`tryWithRetry`:

```
attempts = [
  { delay: 0 },     // initial
  { delay: 200 },   // retry 1
  { delay: 500 },   // retry 2
  { delay: 1500 },  // retry 3
]

for each attempt:
  if attempt.delay > 0: sleep(attempt.delay)
  try:
    return { ok: true, value: await fn() }
  catch (err):
    if isTransient(err) and not last attempt: continue
    return { ok: false, error: err }
```

`isTransient(err)`:

- HTTP 429, 5xx in `err.message`, `err.status`, `err.statusCode`, or `err.cause` — transient.
- `ETIMEDOUT` / `ECONNRESET` / `network` substrings in `err.message` — transient.
- `RagError` wrappers such as `UPSERT_ERROR` should be classified by their message/cause because `VectorRag` may wrap the original embedder error and drop structured HTTP fields.
- Anything else — permanent (don't retry).

The current throttle (`if (added % 10 === 0) sleep(100)`) stays as-is — it's a load-shaping measure, distinct from retry.

Implementation note: export `isTransient` and `tryWithRetry` from `srv/rag-collections.ts` (or move them into a small local helper module) so the unit tests can cover them directly without reaching through private module state.

### 3. Server: warn log when added < total

After the loop, if `added < docs.length`:

```ts
log.warn('Bulk add partial', {
  collection: collectionId,
  total: docs.length,
  added,
  failed: docs.length - added,
  firstErrors: errors.slice(0, 5),
});
```

Reuses the existing `cds.log()` infrastructure (look at how `rag-handler.ts` already calls `log.info('File uploaded', ...)` for the upload event).

### 4. Client: chat-📎 surfaces parity, flags loss

`app/chat/webapp/index.html:handleQuickFileAttach` — after the upload response:

```js
const chunks = data.chunks;
const added = typeof data.added === 'number' ? data.added : chunks;
const failed = chunks - added;
attachedFiles.push({ name: file.name, chunks, added, failed });
renderAttachedFiles();
if (failed > 0) {
  alert(
    `${file.name}: ${added}/${chunks} chunks indexed.\n` +
    `${failed} chunk(s) failed — some content may be missing from search/export. ` +
    `Try re-uploading or check server logs.`
  );
}
```

`renderAttachedFiles` — change the chunk count rendering:

```js
const countLabel = f.failed > 0
  ? `<span style="color:#ff5555">${f.added}/${f.chunks} chunks</span>`
  : `<span style="color:#555">${f.chunks} chunks</span>`;
```

The Manage `uploadFile` status already surfaces both numbers — no change needed there.

## Error handling

| Condition | Behavior |
|---|---|
| RAG write returns `{ ok: false }` from `stored.rag.upsert(...)` | `addDocument` throws before persisting the document; `addDocumentsBulk` retry/error handling owns the outcome. |
| Transient embedder error on chunk N (HTTP 429, 5xx, network) | Retry up to 3 times with backoff. If all retries fail, count as failed, continue. |
| Permanent error (4xx ≠ 429, validation) | Don't retry. Count as failed, continue. |
| Total `added < docs.length` | Warn log on server. Red counter in chat-📎 UI. Alert toast in chat-📎. |
| Manage upload partial | Already surfaces `Uploaded: N chunks, M added`. Add a `color:#ff5555` style when `added < chunks`. |
| All chunks fail | Response is still 200 with `added: 0`. UI handles via the same `failed > 0` path. (No need to surface a 500 from the upload handler — `errors[]` is what the client checks.) |

## Testing

**Unit (Jest with ts-jest):**

- `tryWithRetry`:
  - first attempt succeeds → 1 call, no sleep, ok
  - first 2 attempts throw transient, 3rd succeeds → 3 calls, [200ms, 500ms] sleeps, ok
  - all 4 attempts throw transient → 4 calls, [200, 500, 1500] sleeps, not ok
  - first attempt throws permanent → 1 call, not ok, no retry
- `isTransient`:
  - HTTP 429 / 503 / 504 / network errors → true
  - HTTP 400 / 401 / 403 / 404 → false
  - Errors with no recognizable signal → false (conservative)
- `addDocumentsBulk` integration (in-memory rag store with mock embedder):
  - All succeed → `added === docs.length`, `errors === []`
  - 2 chunks fail transiently → all eventually added
  - 1 chunk fails permanently → `added === docs.length - 1`, `errors` non-empty

**Manual (after deploy):**

- Upload a large file via chat-📎 while sending chat messages → verify `added === chunks` in the attached-files bar.
- Force a failure: stub the embedder to return 503 on chunk index 3 once → verify the row stays neutral (not red) because retry succeeds.
- Force permanent failure: stub the embedder to return 401 on chunk index 5 → verify the row turns red with `4/5 chunks` count and the alert appears.
- Manage upload: same large file → `Uploaded: N chunks, N added` (green), no regression.

## File touch list

- `srv/rag-collections.ts` — make `addDocument` throw on failed RAG `Result`; extract/export `isTransient`, `tryWithRetry`; refactor `addDocumentsBulk` to use them; add the warn log.
- `srv/rag-handler.ts` — no functional change needed (response already exposes `added`, `errors`).
- `app/chat/webapp/index.html` — `handleQuickFileAttach` + `renderAttachedFiles` + (optional) red styling on `uploadFile` status when partial.
- `test/unit/rag-collections-bulk.test.ts` (new) — unit tests for retry, isTransient, integration with in-memory store.

## Open questions

None. Retry counts (`[200, 500, 1500]`) chosen as the conventional short/medium/long backoff and total ~2.2s worst-case delay per failing chunk — bounded enough not to balloon upload time when many chunks transiently fail.
