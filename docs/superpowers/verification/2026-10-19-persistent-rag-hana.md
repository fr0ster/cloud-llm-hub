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
| Search in chat | not run, see below | not run |
| History recall | not run, see below | not run |

Two restarts were made (one after an env change, one formal). Each restored
`collections: 2, removedSessions: 0, degraded: 0, foreign: 0, rejected: 0`.
Totals: 22/22 before the restart, 10/10 read-side checks after it.

Restored document `metadata` carries only the caller's keys (upload chunk info, correction info); the
hub's payload keys (`collectionId`, `docId`, `createdAt`, `_createdAtMs`) are stripped. Query results
show them in their metadata, as the spec's payload defines.

## Not covered

- **Search in chat and history recall.** The subaccount has no destination the hub can use for chat:
  `S4HANA_DEV` (the template default) does not exist and `E19_HTTP` needs a per-user SAP login. With
  no destination the hub serves the LLM-only agent, which by design has no RAG (`ragQueryK: 0`, no
  collections, no history). These two steps need a user session with a working SAP destination
  (browser UI with SAP credentials).
- **Session expiry sweep.** `expiresAt` is set (24 h); the hourly sweep was not waited for.

## Deployment fixes found on the way

- `tools/generate-tool-embeddings.ts` opened the HANA provider locally (no `VCAP_SERVICES`) and stopped
  `tools/deploy.sh`; the build now starts only the tools class (`93b2be9`).
- `mta.yaml`: mbt rejects `optional` on a requires entry; removed (`c315d02`).
- `LLM_AGENT_PRESENTATION_MODEL` is declared in `mta.yaml` without a default and is missing from the
  `.mtaext` templates, so `cf deploy` fails to resolve it. The POC `.mtaext` sets it to `""`; srv does
  not read it. Pre-existing; for the main repo.
