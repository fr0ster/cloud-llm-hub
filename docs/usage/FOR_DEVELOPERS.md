# Cloud LLM Hub — capabilities for developers

What Cloud LLM Hub provides for integration with your services.

## Main advantages

- **Intelligent context management.** The hub assembles the agent context per request: RAG artifacts, selected ABAP tools, role-filtered tool inventory, session/history window, destination context, and request-scoped external tools. Consuming services do not have to build that context pipeline themselves.
- **Flexible integration surface.** The same hub can be consumed as MCP Streamable-HTTP, OpenAI-compatible Chat Completions, Anthropic-compatible Messages API, Web UI backend, script endpoint, or internal-service backend.
- **Large ABAP MCP toolset.** Built-in `mcp-abap-adt` integration exposes roughly 149 tools: read/search, where-used, dictionary/source access, runtime dump/log analysis, and CRUD/check/activate operations where the caller's role allows them.
- **SmartAgent on top of MCP.** Services can call the LLM agent instead of driving MCP manually. The hub handles tool selection, RAG retrieval, role filtering, external tools, streaming, and the bounded agent loop.
- **Request-scoped external MCP/tools.** A consuming service can pass its own tools for one request, including domain actions or calls to service-specific MCP servers, without changing Cloud LLM Hub code.
- **Reusable RAG context.** Project standards, support findings, design notes, and reusable prompts can be retrieved by the agent instead of being pasted by every service.
- **Role-based tool exposure.** Reader, Analyst, Developer, and Full roles expose different tool inventories before the model sees them.
- **Provider and pipeline abstraction.** Consuming services keep the same API while the hub changes LLM provider, RAG backend, classifier/preprocessor behavior, or iteration limits by deployment configuration.
- **Managed runtime on BTP.** A consuming service does not have to own SAP destination handling, auth, sessions, streaming, traces, or provider wiring by itself.

## Direct MCP access from your services

Cloud LLM Hub exposes the built-in `mcp-abap-adt` toolset over standard MCP Streamable-HTTP. Any MCP-aware service in your platform can use it as an ABAP-system-aware tool provider — no need to embed an MCP client into each consuming service or to reimplement ABAP-system connectivity.

## Calling the LLM agent through HTTP

For services that already speak OpenAI- or Anthropic-compatible HTTP, the hub exposes the same agent through:

- The OpenAI Chat Completions shape (streaming and non-streaming).
- The Anthropic Messages shape (streaming and non-streaming).

The same SmartAgent serves both — you choose the shape your consuming service already speaks.

## Injecting your own MCP tools into a request

A consuming service can pass its **own tools** to the hub for the duration of one request. The agent receives them alongside the built-in MCP tools and reasons with both inventories together.

This means a service can extend the agent with its own domain actions (ticket reads, test-management calls, monitoring callbacks, custom business actions, calls into a service-specific MCP server) without registering anything in the hub configuration and without rebuilding the agent loop. The hub stays general; the service brings the workflow-specific hands.

Available through:

- The `tools` field in OpenAI-shape and Anthropic-shape request bodies.
- Standard MCP tool registration on the Streamable-HTTP endpoint.

## Context management

Cloud LLM Hub manages what context the LLM actually sees, so the consuming service does not have to do it manually:

- **Tool relevance filtering.** Tool definitions are embedded and selected by relevance to the current turn. A large inventory does not blow up the prompt.
- **Role-based tool exposure.** Tools outside the caller's role are removed from the inventory before the agent ever sees them. The agent cannot accidentally try to call a tool the user is not allowed to use.
- **RAG retrieval.** Top-k artifacts from the relevant collection are injected for the current turn — project standards, conventions, skill prompts, prior findings. The consuming service does not have to paste them every request.
- **Bounded history window.** Conversation history is trimmed to a configurable window so multi-turn sessions stay cost-bounded.
- **Bounded agent loop.** The agent stops on either explicit completion or a configurable iteration cap.

## Role-based access control to built-in tools

Role membership in BTP role collections drives the agent's tool surface per request:

- **Reader** — read-only ABAP tools (source, includes, dictionary, where-used, object search).
- **Analyst** — Reader plus runtime / dump / log tools.
- **Developer** — Analyst plus create / update / check / activate per object type via standard ADT.
- **Full** — full tool surface; administrator group only.

Scopes are cumulative. The hub filters before the agent sees the inventory, not after the model proposes a call — a lower-role caller's agent literally does not know the higher-role tools exist for that request.

## LLM provider switchable per deployment

The same hub code runs against:

- **SAP AI Core Orchestration** (default), so model spend stays in the BTP subaccount.
- **OpenAI** and any OpenAI-compatible endpoint (Azure OpenAI, Ollama, vLLM, …).
- **Anthropic** directly.
- **DeepSeek** directly.

Consuming services do not see which provider is wired up — they call the same hub endpoint regardless.

## Multi-system landscape support

- One hub deployment can serve **many SAP systems** simultaneously, picked per request by destination header.
- An optional **system-code → destination mapping** lets consuming services pass business-level system codes (e.g. `DEV.100`) instead of raw destination names. The hub resolves them.
- Reachability of destinations and re-init of unreachable ones is exposed over HTTP — your monitoring or admin service can poll it.

## Token issuance for downstream clients

The hub exposes the caller's JWT back to them via an HTTP endpoint. Consuming services that need to hand a bearer token to a downstream client (CLI tool, scheduled job, browser-side widget) can fetch it directly instead of running a separate identity flow.

## Session continuity for multi-turn integrations

For workflows that span multiple requests (multi-step analysis, support investigation, follow-up questioning), the hub supports session identity through the standard mechanisms of each endpoint:

- MCP Streamable-HTTP session ids.
- OpenAI / Anthropic conversation / thread ids.

Use session identity for conversation continuity and tracing. Do not use it as durable workflow storage; persist business state in the consuming service.

## Honesty guard — result-based claim verification *(v6.28+)*

Every channel (`execute_step`, `/v1/chat/completions`, `/v1/messages`) is dispatched through an explicit controller: the SmartAgent runs as a coordinator-less executor worker under a DAG coordinator, and a **reviewer** afterward compares the response's CLAIMS against the **actual tool results**, not tool names. Ground truth comes from `RecordingMcpClient`, a thin `IMcpClient` decorator that captures each executed ABAP tool's real result per request (freed after the request — no retention). On a contradiction the reviewer appends a trailing `UNVERIFIED_WRITE:` notice — NOTICE-ONLY, the executor's content still streams live, and it is a soft warning the consuming service can choose to surface or ignore, never a hard block.

Disable entirely with `LLM_AGENT_STEP_REVIEW_ENABLED=false` if your integration doesn't want the extra check.

## Development mode

The hub supports a mocked-auth development profile so developers building integrations can run the full stack locally without provisioning XSUAA — useful for unit-style integration tests and prompt-pattern iteration.

## SmartAgent pipeline composition

The default pipeline applies in order:

1. Input preprocessors (input normalization, intent enrichment).
2. RAG retrieval against the configured vector store.
3. Tool inventory assembly (built-in MCP + external tools from request body), filtered by role and by relevance.
4. Bounded agent loop with explicit-completion signal.

Pipeline composition is configurable per deployment — alternate components (different RAG type, additional preprocessors, custom classifier) can be wired in without touching consuming services.
