# Task: Integrate cloud-llm-hub with SAP AI Core

## Summary
Integrate SAP AI Core at the `cloud-llm-hub` level so chat requests return LLM answers from AI Core.

## Context
`llm-agent` is the current branch/component in use, but the implementation should be done in `cloud-llm-hub` and structured so it can later be extracted into `llm-agent`.

## Scope
1. Add AI Core connectivity in `cloud-llm-hub` (authentication + inference call).
2. Plug AI Core call into the current chat flow.
3. Use environment variables only for endpoint/model/credentials.
4. Add basic error handling for `401/403`, `429`, `5xx`, and timeout.
5. Add minimal logs: `requestId`, latency, status.
6. Add a short run/validation note.

## Required Configuration
- `AI_CORE_BASE_URL`
- `AI_CORE_AUTH_URL` (if required)
- `AI_CORE_CLIENT_ID`
- `AI_CORE_CLIENT_SECRET`
- `AI_CORE_MODEL_ID`
- `AI_CORE_TIMEOUT_MS`
- `AI_CORE_MAX_RETRIES`

## Acceptance Criteria
1. A chat request through `cloud-llm-hub` returns an LLM response from SAP AI Core.
2. No hardcoded credentials, endpoints, or model IDs.
3. Retry works for `429`/`5xx`; auth and timeout errors are clear.
4. Basic logs are present (`requestId`, latency, status).
5. Short setup/check instructions are documented.
