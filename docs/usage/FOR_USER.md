# Cloud LLM Hub — capabilities for the user

What you can do when you connect to Cloud LLM Hub from a client.

## Main advantages

- **Intelligent context management.** Cloud LLM Hub decides what context the agent should see for the current turn: relevant RAG artifacts, ABAP tool results, conversation/session context, destination context, and request-scoped tools. The user does not have to paste everything into every prompt.
- **Flexible access from different client types.** The same hub can be used as Web UI, MCP server, OpenAI-compatible LLM endpoint, Anthropic-compatible LLM endpoint, script backend, or integration target for internal tools.
- **Large ABAP MCP toolset.** The assistant gets access to roughly 149 ABAP-oriented tools through `mcp-abap-adt`: read/search, where-used, dictionary/source inspection, runtime dump/log analysis, and role-limited CRUD/check/activate operations.
- **Full MCP + LLM-agent mode.** A client can use the hub as a direct MCP endpoint, or call the SmartAgent through OpenAI/Anthropic-compatible APIs and let the agent select tools, retrieve context, and run the loop.
- **Reusable project context.** RAG collections let teams reuse standards, naming rules, design notes, support findings, and reusable prompts without pasting them into every chat.
- **External MCP/tools when needed.** A client can bring local/request-scoped tools into the same conversation, so the assistant can combine hub-side ABAP tools with client-side actions.
- **Role-based tool access.** Reader, Analyst, Developer, and Full users see different tool inventories in the same service. The model does not see tools outside the caller's role.
- **One managed runtime behind all clients.** Users can switch clients without losing the server-side capabilities: destinations, RAG collections, role filtering, streaming, and sessions stay in the hub.

## Client connection options

You can reach Cloud LLM Hub from:

- **A browser**, through the built-in chat Web UI. No client install required.
- **An OpenAI-compatible client** (`goose`, `cline`, `cursor`, ChatGPT-style tools, custom scripts). Cloud LLM Hub exposes an OpenAI Chat Completions endpoint.
- **An Anthropic-compatible client** (`claude` CLI, anything that speaks the Messages API). Cloud LLM Hub exposes the Anthropic Messages endpoint at the same surface.
- **An MCP-native client** (Claude Desktop, MCP-aware editors, custom MCP clients). Cloud LLM Hub exposes a Streamable-HTTP MCP endpoint.

The same agent and the same tools answer through all four channels. You pick the client that fits your workflow.

## Authentication and token issuance

- Sign-in goes through **XSUAA** (the OAuth 2.0 authorization service of SAP BTP), backed by the identity provider configured in your subaccount — typically SAP Cloud Identity Services (IAS) or a corporate IdP federated to it. The hub trusts the JWT XSUAA issues; users do not have to think about the flow once they are signed into BTP.
- The hub also issues your current JWT back to you on request — usable in any CLI tool that expects an `OPENAI_API_KEY`-style bearer token. This means you do not need a parallel API-key issuance flow for clients.

## Multi-system access

- One hub deployment can serve **many SAP systems** simultaneously. You pick the target system per request via a destination header.
- If your deployment has a **system-code shortcut** configured, you can pass a business-level system code instead of the destination name; the hub resolves it.
- You can ask the hub which destinations it currently knows about and which are reachable.

## Built-in MCP tool inventory (ABAP)

When you ask the assistant a question, it has access to ABAP-system tools through `mcp-abap-adt`. What it can do depends on your role:

| Role | What the assistant can do for you |
|---|---|
| Reader | Read ABAP source, includes, dictionary objects (tables, structures, domains, data elements, classes, function modules, interfaces). Where-used traversal. Object search. |
| Analyst | Reader's tools plus runtime dump retrieval, runtime log queries, system message feeds. |
| Developer | Analyst's tools plus create / update / check / activate per object type via standard ADT. |
| Full | Full tool surface, administrator group only. |

The tool list the assistant actually sees is filtered by **your role**, not a system-wide switch. If your role excludes a tool, the assistant cannot call it on your behalf — even if you ask.

## Bring-your-own MCP tools

In addition to the built-in tools, you can attach **your client's local MCP tools** to a request — the hub merges them with the built-in inventory for that conversation. Practical effect: the same assistant can call hub-side ABAP tools **and** your client-side tools (file access, local scripts, editor actions) inside one turn.

Available through:

- The `tools` field in OpenAI-shape and Anthropic-shape request bodies.
- The MCP endpoint, where your client can register tools the standard MCP way.

## RAG: project-scoped knowledge collections

Cloud LLM Hub maintains vector-store collections that the assistant retrieves from on demand. You can:

- **Add** an artifact to a collection (project standards, naming conventions, design notes, reusable skill prompts, customer-specific rules).
- **Correct** an existing artifact under its stable id — the previous version is superseded automatically; the artifact id stays the same.
- **Reuse** a collection across many chat sessions without re-pasting the same context every turn.

Collections are scoped per project / per user / per destination, so different teams keep separate context without contaminating each other.

## Multi-turn session continuity

The assistant carries context across turns inside a session:

- The Web UI keeps the session automatically per conversation tab.
- The MCP endpoint exchanges a session id for protocol continuity; reusing it lets the client continue the same MCP conversation.
- OpenAI / Anthropic clients pass the standard conversation/thread id their tool already supports.

## Streaming responses

The assistant streams tokens back to the client as it generates them. The Web UI shows incremental output; CLI clients that support SSE see the same behavior. Long answers do not require a long blocking wait.

## Role-scoped tool access

Roles are assigned through standard BTP role collections by your platform team. The same hub serves Readers, Analysts, Developers, and Full Admins simultaneously — each sees a different tool surface in the assistant's inventory for their requests. There is no separate per-environment hub for "safe" vs "unsafe" users.

## What it does not replace

- Your SAP authorization model. The hub respects what the destination user can already see.
- Transport / release control.
- Human review for non-trivial output.
- Functional ownership of the business process.

## When the hub matters to a user

Cloud LLM Hub matters when the user wants the same controlled assistant across clients:

- Web UI for browser-based work.
- OpenAI-compatible clients for chat-style workflows.
- Anthropic-compatible clients for Claude-style workflows.
- MCP-native clients for direct tool access.

The user does not have to rebuild the connection model in each client. The hub provides the shared server-side pieces: sign-in, token issuance, destination selection, role-scoped ABAP tools, RAG collections, streaming, and session continuity.
