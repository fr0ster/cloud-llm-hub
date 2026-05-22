# An MCP Server Gives You Tools. Cloud LLM Hub Manages Context.

When people first hear "Cloud LLM Hub", a fair reaction is:
*"OK, so it's an ABAP MCP server with a chat UI in front?"*

It's not. The MCP server is one input. The real value is what happens **on top** of it — and what happens on top is **intelligent context management**.

---

## The problem with "just give the model all the tools"

The built-in `mcp-abap-adt` toolset exposes roughly **149 tools**: read source, search includes, where-used, dictionary lookups, runtime dump and log analysis, plus developer-grade CRUD/check/activate operations.

A plain MCP server (or a VSCode plugin sitting on top of one) hands that whole list to the model. Each request carries the full tool inventory in the prompt.

Three things happen:

- **Noise.** 149 tool definitions push out the actual user question.
- **Cost.** Every turn pays for tokens the model didn't need.
- **Bad reasoning.** With too many irrelevant options, the model picks the wrong tool or invents arguments.

You can patch this on the IDE side, but you'd be reinventing context management — without the platform context to do it well (no shared RAG, no team-level knowledge, no role boundaries).

---

## What Cloud LLM Hub does differently

It doesn't just relay tool calls. Three layers run server-side, on every request:

**1. Semantic tool selection.**
Tool definitions are embedded. For each turn, the Hub semantically searches the inventory and injects only the relevant subset into the model prompt. 149 tools become 5–8 candidates the model can reason about clearly.

**2. RAG with semantic retrieval.**
Per-project collections hold the team's accumulated context — coding standards, design notes, prior code reviews, reusable prompts, support findings. Top-k records by embedding similarity are pulled into the turn automatically. The user does not re-paste what the team already knows.

**3. Role-based pre-filtering.**
Reader / Analyst / Developer / Full role tiers (mapped to BTP roles) trim the tool inventory **before** semantic selection runs. The model cannot propose a tool the caller is not entitled to call. Authorisation is enforced at the tool surface, not after the fact.

That pipeline is what turns the platform from "MCP server with a UI" into an SAP-aware AI agent.

---

## Why VSCode + ABAP MCP isn't equivalent

I'm not arguing against VSCode + an ABAP MCP plugin for personal developer use. That setup gets one developer fast, ad-hoc access to ABAP from inside their IDE. Good.

But it gives you:

- **No shared knowledge layer.** Every developer paste-and-prays their own context.
- **No semantic tool selection.** The IDE either sends the full list or lets the model pick blindly.
- **No role tiers.** Whoever runs VSCode has every tool. There is no "this user is read-only" boundary.
- **One developer per session.** Not a team capability.

Cloud LLM Hub turns the same tool surface into a **managed team capability**: shared RAG, semantic tool selection on every call, role-enforced inventories, one service serving many SAP systems and many consuming applications.

---

## Bottom line

| What you want | What you need |
|---|---|
| ABAP tools in your IDE | An MCP server (e.g. VSCode + ABAP MCP) |
| ABAP tools that the model picks intelligently, shared across your team, governed by role | Cloud LLM Hub |

An MCP server gives you tools. VSCode + MCP gives one developer those tools in an IDE. Cloud LLM Hub gives you **intelligent context management** — semantic tool selection, RAG retrieval, role-based filtering — on top of those tools, available to the whole organisation through any AI client (Claude, ChatGPT-style CLI, MCP-native editors, custom Fiori UIs, internal CAP services).

If you've already invested in an MCP-based ABAP toolset, that investment isn't wasted — Cloud LLM Hub uses it underneath. What it adds is the **context layer** that makes a 149-tool inventory actually usable by an LLM, and the **governance layer** that lets the same capability serve many users safely.

---

*Happy to dig into details — pricing, RAG collection design, role mapping, integration shape (OpenAI / Anthropic / MCP / Web UI / your own CAP service) — drop a comment or DM.*
