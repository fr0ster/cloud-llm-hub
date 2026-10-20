# Persistent RAG collections on HANA: verification

**Date:** 2026-10-20
**Target:** CF org `cloud-llm-hub-dev`, space `llm-agent` (eu10-005), HDI container `hdi-llm`
**Build:** `deploy/poc-hana-rag` at `c315d02`, hub 7.2.1, `@mcp-abap-adt/*` 30.3.1
**Config:** `LLM_AGENT_RAG_BACKEND` and `LLM_AGENT_SESSION_RAG_BACKEND` = `hana-vector`, tools `vector`,
embedder `sap-ai-core` / `text-embedding-3-small` (1536), AI Core credentials from `.env`.
**Caller:** a technical client (xsuaa client_credentials, temporary service key, deleted afterwards), so
the owner of every collection is `system`.

## Startup

- `Persistent collections { backend: 'hana-vector', dimension: 1536 }`.
- First boot: `Persistent collections restored { collections: 0 }`, restore attempt 1 succeeded.
- `/health` 200 `{"status":"UP"}`; `GET /v1/rag/backends` → `["hana-vector"]`.

## Checklist (spec §2.6)

| Step | Before restart | After `cf restart` |
|------|----------------|--------------------|
| Create a user collection | PASS (201, backend `hana-vector`) | listed |
| Add a document | PASS | present |
| Bulk-add (2 documents) | PASS | present |
| Upload a file (1 chunk) | PASS | present, chunk metadata kept |
| List collections / documents | PASS | PASS |
| Semantic query (`which transport…` → `DEVK900042`) | PASS | PASS |
| `rag_add` | PASS | present |
| `rag_correct` | PASS | corrected text, old text gone, correction metadata kept |
| `rag_deprecate` | PASS | record gone |
| Rename and description | PASS | PASS |
| Disable, then delete (throwaway collection) | PASS / PASS (204) | stays deleted |
| Session collection (cookie `clh_session`, `expiresAt` set) | PASS | its document present |
| Search in chat | FAIL: collection injected, every document filtered out (see below) | not run |
| History recall | PASS (in the same session) | FAIL: a new session is issued after the restart (see below) |

Two restarts were made (one after an env change, one formal). Each restored
`collections: 2, removedSessions: 0, degraded: 0, foreign: 0, rejected: 0`.
Totals: 22/22 before the restart, 10/10 read-side checks after it.

Restored document `metadata` carries only the caller's keys (upload chunk info, correction info); the
hub's payload keys (`collectionId`, `docId`, `createdAt`, `_createdAtMs`) are stripped. Query results
show them in their metadata, as the spec's payload defines.

## Chat

Through `E19_HTTP` with the technical SAP user `MCPDEV01` (`e19-tech.env`); the SAP credentials went in
the `x-sap-login` / `x-sap-password` headers, nothing was written to the destination. With no destination
at all the hub serves the LLM-only agent, which has no RAG by design (`ragQueryK: 0`).

- **Search in chat: FAIL, pre-existing on main.** `X-Rag-Collections: pocverify` resolves and injects the
  collection (`Dynamic RAG collections injected`), but the hub's own search returns nothing. It wraps the
  store in `ExpositionFilteringRag`, whose post-filter drops every record without an `exposition` tag (the
  v6.22.0 fail-closed fix for untagged tools). User documents carry no such tag, so on every backend chat
  finds none of them. Upstream main wraps the collections the same way (`srv/openai-handler.ts`).
- **History recall within a session: PASS.** A fact given in one turn was recalled in the next one, and
  `rag_query_history` found the stored turn.
- **History recall after `cf restart`: FAIL, this branch.** The turns are in HANA, but the session
  middleware keeps a presented `clh_session` only when `sessionIsLive` knows it, from retention or session
  state, both in memory. After a restart the session is unknown and a new one is minted (`s-9280d6cb…`
  before, `s-b838084b…` after, same cookie), so the stored turns, keyed by (userId, sessionId), are never
  reached. A session that holds a session collection survives, because its restored collection makes it
  known.
- **Session collection and destination change.** The first chat request on a destination clears the
  session (`Destination reconnect, clearing session history`), its session collections included. That is
  the designed behaviour; this session collection had been created before the first chat.
- **Session expiry sweep.** `expiresAt` is set (24 h); the hourly sweep was not waited for.

## Deployment fixes found on the way

- `tools/generate-tool-embeddings.ts` opened the HANA provider locally (no `VCAP_SERVICES`) and stopped
  `tools/deploy.sh`; the build now starts only the tools class (`93b2be9`).
- `mta.yaml`: mbt rejects `optional` on a requires entry; removed (`c315d02`).
- `LLM_AGENT_PRESENTATION_MODEL` is declared in `mta.yaml` without a default and is missing from the
  `.mtaext` templates, so `cf deploy` fails to resolve it. The POC `.mtaext` sets it to `""`; srv does
  not read it. Pre-existing; for the main repo.
