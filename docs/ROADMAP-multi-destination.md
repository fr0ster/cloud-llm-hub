# Multi-Destination Support — Roadmap

Dynamic SAP destination switching with per-destination tool vectorization.

## Architecture

```
Map<destination, {
  mcpAdapter: McpClientAdapter,
  toolsRag: IRag,
  toolCount: number,
  status: 'ready' | 'vectorizing' | 'error',
  error?: string
}>
```

- Primary destination (from env var) vectorized blocking at startup
- Other SAP destinations vectorized in background
- On switch: swap MCP adapter + tools RAG (pre-built), rebuild SmartAgent (fast)
- Failed destinations excluded from UI dropdown

## Tasks

### Phase 1: BTP Destinations Discovery ✅
- [x] `srv/lib/btp-oauth.ts` — shared OAuth2 helper extracted from ai-core-models.ts
- [x] `srv/lib/btp-destinations.ts` — fetch subaccount destinations from BTP Destination Service REST API
- [x] Filter: OnPremise + BasicAuth with SAP-like URLs (heuristic)
- [x] Cache with TTL (5min, same as models)
- [x] Graceful fallback: if API fails, return only current destination from env
- [x] Refactored `ai-core-models.ts` to use shared `btp-oauth.ts`

### Phase 2: Multi-Destination Agent Manager ✅
- [x] New type `DestinationState` — mcpAdapter, toolsRag, status, toolCount, error
- [x] `destinationStates: Map<string, DestinationState>` in agent-manager.ts
- [x] Extract `buildEmbeddedMcpAdapter()` to accept destination name parameter
- [x] Extract tool vectorization into reusable `vectorizeTools()` function
- [x] Shared embedder + RAG stores (facts, feedback, state) persist across destination switches
- [x] Primary destination: vectorize blocking (existing behavior)
- [x] Background vectorization: `initBackgroundDestinations()` after agent ready
- [x] Per-destination status tracking: ready / vectorizing / error
- [x] `getSmartAgent(model?, destination?)` — switch destination using pre-built state
- [x] On destination switch: rebuild SmartAgent with pre-built mcpAdapter + toolsRag
- [x] Export `getDestinationStates()` for API/UI consumption
- [x] Export `getCurrentDestination()` for status reporting

### Phase 3: API Integration ✅
- [x] `GET /v1/models` — include `_destinations` + `_active_destination` in response
- [x] `POST /v1/chat/completions` — read destination from `X-SAP-Destination` header
- [x] Pass destination to `getSmartAgent(model, destination)`
- [x] Return active destination in SSE response metadata (`X-SAP-Active-Destination` header)

### Phase 4: UI Destination Selector ✅
- [x] Destination `<select>` dropdown in system bar (same style as model selector)
- [x] Populate from `/v1/models` `_destinations` field
- [x] Show status indicator: ready (✓), vectorizing (⏳), error (✗) + tool count
- [x] Send selected destination in `X-SAP-Destination` header on chat requests
- [x] Disable options that are not yet ready (status !== 'ready')
- [x] Periodic refresh (15s) for background vectorization status updates

### Phase 5: Testing & Polish
- [ ] Test destination switch DEV → TST via UI
- [ ] Test background vectorization completes without blocking primary
- [ ] Test error handling: unreachable destination (QAS) shows error status
- [ ] Test fallback: BTP API unavailable → only env var destination available
- [ ] Verify Cline still works (X-SAP-Destination header passthrough)
