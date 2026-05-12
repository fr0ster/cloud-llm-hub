# Cloud LLM Hub — capabilities for management

What Cloud LLM Hub delivers as a managed server-side agent capability.

## Main advantages

- **Intelligent context management.** The hub controls what the LLM sees for each task: project RAG, ABAP tool results, selected MCP tools, role boundaries, session context, destination context, and external tools supplied by consuming services. This is the main differentiator over plain chat or direct model calls.
- **Flexible integration model.** One platform can be used as Web UI, MCP server, OpenAI-compatible LLM endpoint, Anthropic-compatible LLM endpoint, script backend, and integration backend for internal services.
- **Large ABAP MCP capability surface.** The hub exposes roughly 149 ABAP-oriented MCP tools: read/search, where-used, dictionary/source inspection, runtime dump/log analysis, and developer CRUD/check/activate operations where allowed.
- **Full MCP plus agent orchestration.** Teams can use direct MCP access when they want tool-level control, or use the LLM agent endpoints when they want automatic tool selection, RAG context, and multi-step reasoning.
- **Project context becomes reusable.** RAG collections store customer standards, design notes, support findings, and reusable prompts so teams do not re-paste the same context every session.
- **External MCP/tools for new use cases.** Consuming services can pass their own tools per request, while shared capabilities stay in the hub. New workflows do not require forking the platform.
- **Role-based access control at tool level.** Reader, Analyst, Developer, and Full roles expose different capabilities inside the same service. The model does not see tools outside the caller's role.
- **Provider and pipeline choices stay centralized.** Model provider, RAG behavior, classifier/preprocessor pipeline, and iteration limits are deployment/runtime concerns, not something each consuming service must rebuild.
- **Managed BTP runtime, not only a Web UI.** The Web UI is one entry point; the same backend serves AI clients, MCP-native clients, scripts, internal services, and automation.

## Capability highlights

### One AI plug for the SAP landscape

The same service serves the whole organization — business users, support, analysts, developers, automation. No per-team AI experiment, no per-tool identity, no per-service prompt library. One governed entry point.

### AI that uses the real ABAP system

The assistant operates against real ABAP systems through standard channels (ADT, runtime APIs). It can read actual source code, dictionary objects, where-used information, runtime dumps, and logs; for developer roles it can also use change-capable CRUD/check/activate tools exposed by the underlying MCP server.

### Project memory across teams and sessions

Customer standards, naming conventions, architecture decisions, support history, design notes, reusable prompt patterns — stored in project-scoped knowledge collections and retrieved automatically when relevant. Users do not re-paste the same background every chat.

### Role-based tool surface inside one service

Reader, Analyst, Developer, Full — four role tiers mapped to BTP role collections. The same service exposes a different tool surface to each user. An analyst's session literally cannot trigger object creation; an administrator's session can. Authorization is enforced at the tool level, not just at the endpoint level.

### Works with any AI client the user already prefers

Web chat in the browser. `claude` CLI, `goose`, `cline`, `cursor`, ChatGPT-style tools — anything that speaks OpenAI- or Anthropic-compatible HTTP. MCP-native clients (Claude Desktop, MCP-aware editors). One backend, many fronts, no client lock-in.

### Multi-system landscape support out of the box

One deployment serves many SAP systems simultaneously. Users select per request. An optional system-code shortcut lets business processes refer to systems by their familiar code instead of a destination name.

### Provider flexibility without rewiring consumers

Model provider is a configuration choice — SAP AI Core Orchestration by default (spend stays in the BTP subaccount), switchable to OpenAI, Anthropic, DeepSeek, or any OpenAI-compatible endpoint. Consuming services and clients see no change.

### Request-scoped tool injection by consuming services

A consuming application can attach its own tools — ticket reads, test-management actions, monitoring callbacks, custom business actions — to a single request. The hub reasons with those alongside the built-in SAP tools. New AI-driven use cases land as integration jobs, not as fresh ML projects.

This is important for long-term evolution: not every new capability has to be added to the central hub codebase. Shared capabilities can move into the platform; domain-specific capabilities can stay owned by the service that needs them.

### Streaming responses

Tokens arrive incrementally. The user sees progress instead of staring at a blank screen during long analyses.

### Multi-turn session continuity

The assistant carries context across related requests inside one investigation, one support case, one analysis run — without the consuming service having to reassemble the history.

### Token issuance for clients

Users get their own JWT from the hub UI to configure any CLI tool that expects a bearer token. No parallel API-key flow to provision.

### Audit trail

Every request authenticated via XSUAA. Correlation IDs, session traces, tool-call traces — reviewable per session.

### Existing integrations already running

- **abap-dump-monitor** — CAP service polling ABAP dumps, surfacing analyzed results in a Fiori UI.
- **calm-dump-analyzer** — receives SAP Cloud ALM alerts about runtime errors, returns structured triage.
- **test-management** — prototype CAP service wiring AI-assisted test review into a Fiori list-page.

Each is a working reference any future integration can be modeled after.

## What it is not

- Not a replacement for SAP developers.
- Not a chatbot trained on customer code — no training, no leak of source into vendor model weights.
- Not a bypass around SAP authorizations, transports, or release processes.
- Not an unattended code shipper — change-capable actions stay inside the normal review chain.
