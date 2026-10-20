# Long sessions on HANA: verification

**Date:** 2026-10-20
**Target:** CF org `cloud-llm-hub-dev`, space `llm-agent` (eu10-005), HDI container `hdi-llm`
**Build:** `deploy/poc-hana-rag` at `dad46a7` (`feat/long-sessions`), hub 7.2.1, `@mcp-abap-adt/*` 30.3.1
**Config:** startup log `Long-session configuration { ttlMs: 3600000, maxSessions: 50, maxPerUser: 5,
queueLength: 2, store: 'hana-vector', plainApi: false, plainMcp: false }`; the store follows
`LLM_AGENT_SESSION_RAG_BACKEND=hana-vector`, nothing new in the POC `.mtaext`.
**Caller:** a technical client (xsuaa client_credentials, temporary service key, deleted afterwards).
**SAP:** destination `E19_HTTP`, technical user from `e19-tech.env`; credentials only in the
`x-sap-login` / `x-sap-password` / `x-sap-client` headers, nothing written to the destination.

## Results

| Step | Result |
|------|--------|
| `/v1/chat/completions` without a key | PASS: 400 `SESSION_REQUIRED` |
| `/mcp/stream/http` | PASS: 404 `PLAIN_MCP_DISABLED` |
| `POST /v1/session { destination: E19_HTTP }` | PASS: 201, `ls-…` key, `ttlSeconds` 3600 |
| Two chats with `x-clh-session` | PASS: the second recalls a codeword given in the first |
| Same key, another SAP login | PASS: 403 `SESSION_CREDENTIAL_MISMATCH` (code in `error.type`, see below) |
| Unknown key in the header | PASS: 404 `SESSION_NOT_FOUND` |
| Agent MCP `session_open` | PASS: key, TTL, destination |
| Two `execute_step` with `session` | PASS: the second recalls a number given in the first |
| `cf restart`, HTTP key | PASS: 200 with `x-clh-session-notice: revived`; the codeword recalled from HANA |
| Next response of the revived session | PASS: no notice |
| `cf restart`, MCP key | PASS: revived, the number recalled |
| `DELETE /v1/session` | PASS: 204; the key then gives 404 `SESSION_NOT_FOUND` |
| `session_close` | PASS: `{"closed":true}`; `execute_step` with the key then gives `SESSION_NOT_FOUND` |
| WebUI: connect, chat, restart, notice | NOT RUN: needs an interactive login through the approuter |

Revival after the restart proves the session records were written to and read from the HANA store
(`h_sessions`, zero-vector rows). No warnings or errors in the srv log apart from the SDK's
basic-authentication notice for the on-premise destination.

## Found on the way

- The credential refusals (401 `SAP_CREDENTIALS_REQUIRED`, 403 `SESSION_CREDENTIAL_MISMATCH`) carry
  their code in `error.type`, the shape of every SAP credential failure, not in `error.code` like
  the other session refusals. Kept, and documented in API_REFERENCE.

## Not verified

- History and session collections deleted from HANA after a close: the closed keys are refused,
  the rows themselves were not inspected.
- The old ABAP session after a restart is left to SAP's timeout by design (close from identifiers
  waits for `@mcp-abap-adt/connection`).
