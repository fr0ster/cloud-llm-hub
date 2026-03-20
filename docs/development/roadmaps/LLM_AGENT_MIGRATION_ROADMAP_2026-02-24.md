# LLM Agent Migration Roadmap (2026-02-24)

## Context

Target: migrate from `@mcp-abap-adt/llm-proxy` to renamed and significantly updated `@mcp-abap-adt/llm-agent`, while preserving cloud-llm-hub architecture:

- LLM path must use **SAP AI Core** (not direct DeepSeek/OpenAI keys).
- MCP path must use **cloud-llm-hub MCP runtime** (`/mcp/stream/http` or internal runtime adapters), not external standalone MCP server wiring.

## Current State (As-Is)

### Dependency and imports

- `package.json` uses `@mcp-abap-adt/llm-proxy` `^0.0.1` (`package.json:6`).
- `srv/agent-manager.ts` imports `SapCoreAIProvider`, `SapCoreAIAgent`, `MCPClientWrapper` from `@mcp-abap-adt/llm-proxy` (`srv/agent-manager.ts:20-26`).
- `srv/agent-service.ts` imports `Message` from `@mcp-abap-adt/llm-proxy` (`srv/agent-service.ts:12`).

### Behavior gap vs “real agent” expectation

- `Chat` does **not** use orchestrating agent flow. It calls `createLLMProvider(...).chat(...)` directly (`srv/agent-service.ts:49-77`).
- `getAgent(req)` exists but is not used by `Chat` (`srv/agent-manager.ts:237`, `srv/agent-service.ts:32-83`).
- `GetHistory` returns empty array always (`srv/agent-service.ts:90-93`).
- `ClearHistory` is stub only (`srv/agent-service.ts:99-105`).
- `Health` returns `llmReady`, but CDS model expects fields like `agentReady`, `mcpConnected`, `mcpDestination` (`srv/agent-service.ts:133-140` vs `srv/agent-service.cds`).

### Existing good foundations

- MCP config builder already injects `X-SAP-Destination` and auth (`srv/agent-manager.ts:44-77`).
- Agent cache and MCP degraded mode are already implemented (`srv/agent-manager.ts:250-327`).
- AI Core service binding loader already exists (`srv/agent-config.ts`).

## Expected Target (To-Be)

`AgentService.Chat` should run full agent orchestration:

1. resolve config,
2. get/create agent instance,
3. run agent process loop,
4. allow tool usage through MCP,
5. return final assistant response,
6. expose real history and health.

For this repo specifically, llm-agent integration must be done via cloud-llm-hub adapters:

- **LLM adapter:** AI Core-backed implementation (service binding, OAuth2 client credentials).
- **MCP adapter:** cloud-llm-hub MCP implementation (prefer in-process interface integration if new llm-agent supports it; fallback to self-loop `/mcp/stream/http`).

## Delta Matrix (What must change)

1. Package rename and API surface
- Replace `@mcp-abap-adt/llm-proxy` with `@mcp-abap-adt/llm-agent`.
- Update imports and type names in `srv/agent-manager.ts`, `srv/agent-service.ts`.

2. Runtime flow
- Replace direct provider chat in `Chat` with `getAgent(req)` + `agent.process(message)`.
- Wire `GetHistory` and `ClearHistory` to real cached agent instances.

3. Adapter-based integration
- Move from provider-specific direct instantiation to llm-agent interfaces.
- Implement AI Core adapter and MCP adapter in `srv/agent/` (new folder suggested).

4. Health contract correctness
- Return fields aligned to CDS contract: `agentReady`, `mcpConnected`, `mcpDestination`, etc.

5. Tests and compatibility
- Update unit/integration tests to validate:
  - with MCP available,
  - MCP unavailable (LLM-only degraded mode),
  - history lifecycle,
  - health fields and semantics.

## Migration Plan (Phased)

## Phase 0: API Baseline Capture (blocking)

Goal: freeze exact llm-agent API expected by code.

- Pull llm-agent `README`, `CHANGELOG`, exported typings.
- Build a mapping table: `llm-proxy symbol -> llm-agent symbol`.
- Confirm whether new llm-agent has:
  - built-in tool execution loop,
  - provider interface abstraction,
  - MCP interface abstraction (list/call/connect hooks).

Exit criteria:
- Migration mapping doc with zero unknowns for used symbols.

## Phase 1: Dependency + Compatibility Layer

Goal: switch package with minimal blast radius.

- Update dependency in `package.json` and lock file.
- Create adapter wrapper module, e.g. `srv/agent/runtime.ts`, to isolate llm-agent imports from service code.
- Keep external behavior unchanged initially.

Exit criteria:
- Typecheck/build green after rename with compatibility wrapper.

## Phase 2: Enable Full Agent Orchestration in Service

Goal: make `AgentService` truly agentic.

- In `srv/agent-service.ts`:
  - `Chat`: use `getAgent(req)` and `agent.process(message)`.
  - `GetHistory`: return real history from agent.
  - `ClearHistory`: call agent clear/reset API.
- Align health output with CDS schema.

Exit criteria:
- OData endpoints behavior matches CDS model and agent semantics.

## Phase 3: Implement Cloud-LLM-Hub Adapters

Goal: integrate new llm-agent through local platform abstractions.

- Add `srv/agent/adapters/ai-core-provider.ts`:
  - encapsulate AI Core auth/token/service URL logic,
  - preferably use SAP Cloud SDK HTTP path where feasible.
- Add `srv/agent/adapters/mcp-runtime.ts`:
  - Option A (preferred): in-process MCP adapter via llm-agent MCP interfaces.
  - Option B: keep MCP HTTP self-loop adapter (`/mcp/stream/http`) if interface parity is insufficient.
- Keep destination propagation (`X-SAP-Destination`) and request auth propagation.

Exit criteria:
- Agent can use MCP tools against hub-managed MCP path, not external server assumptions.

## Phase 4: Hardening and Regression Safety

Goal: production-safe migration.

- Add tests for:
  - AI Core token failures,
  - destination missing/invalid,
  - MCP timeouts/errors and degraded mode,
  - cache TTL and per-destination cache key behavior.
- Add logs/metrics around:
  - tool-call attempts,
  - degraded mode entry count,
  - agent latency segments (LLM vs MCP).

Exit criteria:
- Test suite + smoke tests pass, no contract regressions.

## Phase 5: Rollout

Goal: controlled rollout in BTP.

- Deploy behind feature flag, e.g. `LLM_AGENT_RUNTIME=v2`.
- Canary route for agent endpoints.
- Observe error rate, latency, MCP tool success rate.
- Remove legacy path after stable window.

Exit criteria:
- Legacy llm-proxy path removed.

## Concrete File-Level Change List

1. `package.json`
- replace `@mcp-abap-adt/llm-proxy` with `@mcp-abap-adt/llm-agent`.

2. `srv/agent-manager.ts`
- migrate imports,
- keep caching/buildMCPConfig,
- bind new llm-agent interfaces via adapters.

3. `srv/agent-service.ts`
- switch from direct `llmProvider.chat(...)` to agent orchestration path,
- implement real history/clear,
- fix health output fields.

4. `srv/agent-service.cds`
- confirm contract still matches runtime response.

5. `test/*agent*`
- add/update tests for orchestration and degraded mode.

6. `docs/architecture/ARCHITECTURE.md`
- update package naming and actual runtime behavior to remove current mismatch.

## Key Risks

- API breakage between `llm-proxy` and `llm-agent` may be larger than rename.
- Current manual AI Core auth code may diverge from new llm-agent auth abstraction.
- History semantics may change with new agent runtime (per-instance vs shared vs external store).
- In-process MCP adapter may require exposing internal hooks currently not public in hub.

## Definition of Done

- Dependency migrated to `llm-agent`.
- `Chat` uses full agent orchestration (not direct provider chat).
- MCP tool path works through cloud-llm-hub managed MCP context.
- AI Core integration remains service-binding based.
- CDS health/history contracts are honored by runtime responses.
- Tests validate normal and degraded scenarios.

## Registry Access Status (Updated 2026-02-24)

- npm registry access has been re-verified successfully.
- `@mcp-abap-adt/llm-agent` current version: `1.0.1`.
- `dist-tags.latest`: `1.0.1`.

Phase 0 remains required for API mapping, but is no longer blocked by registry connectivity.
