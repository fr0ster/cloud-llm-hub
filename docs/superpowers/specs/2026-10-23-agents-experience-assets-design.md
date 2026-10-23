# Agents: profile, experience, assets — design (draft)

Date: 2026-10-23. Status: draft for review. Replaces the earlier "planner skills and lessons" draft.
Scope: cloud-llm-hub dialogue coordinator (planner + workers), WebUI and the agent MCP; llm-agent components
where the library is the right home.

## 1. Idea

An **agent** is a named entity the user picks when a session starts. It is made of three parts:

| Part | What it is | How it changes |
|---|---|---|
| **Profile** | How the agent works: planning style (how fine-grained, how much it looks for non-standard solutions), budget (tokens/steps), specialisation (e.g. code review, complex cases), optionally model choice | Set by the owner, versioned |
| **Experience** | A collection of lessons: how to plan, how to call tools, what to avoid | Grows after every session (retrospective) |
| **Assets** | Extra sources: information (RAG collections, files, landscape description) and extra MCP servers (tools beyond SAP) | Attached by the owner |

Examples of agents the user described: one reviews code better; one plans in the finest detail; one plans
coarser but finds non-standard solutions; one solves simple tasks cheaply; one spends a lot but handles complex
cases. They differ mainly by **profile**; **experience** reinforces the profile over time; **assets** give them
domain sources and tools.

## 2. Lifecycle

1. **Pick.** At session start the user picks an agent: a list in the WebUI; a parameter on the agent MCP for
   Claude / Codex / Copilot (the main channel). No pick → a default agent.
2. **Work.** The planner runs with the agent's profile; relevant active lessons and the agent's assets are
   injected next to `[environment]` (not persisted in the conversation). Tool lessons go into worker briefs.
3. **Retrospective.** After the session (and after failed tasks) the hub runs a retrospective turn: what went
   well, what failed, why, and the lessons. Lessons are written to the experience of the agent that worked.
4. **Next session.** The new lessons are used once active (see §4).

## 3. Ownership, publishing, inheritance

- **Private by default.** An agent belongs to the user who created it (like user-scope collections today).
- **Publish = snapshot version.** Publishing freezes a version (profile + experience + asset references).
  Sessions of other users never change a published version; the author releases new versions deliberately.
- **Access by role.** A published agent is visible to users with a given role (XSUAA role collections, as the
  hub already uses for admin).
- **Attach a published agent to a session.** Its experience and profile are read-only in that session; lessons
  from the session go to the user's own agent, never to the published one.
- **Base agent for training.** A new agent can start from a published version as its base and add its own layer
  on top. When a lesson in the own layer contradicts the base, the own layer wins.

## 4. Experience: lessons

- **Lesson record:** text (one or two sentences), subject (`planning` | `tool:<name>` | `system:<id>`),
  source system, created/confirmed counts, status `draft` | `active` | `deprecated`, agent id and version.
- **Storage:** a collection per agent, written with the existing server-side `rag_add` / `rag_correct` /
  `rag_deprecate`.
- **Quality:** a new lesson is `draft` and is not injected. It becomes `active` when confirmed (see decisions).
  A wrong lesson is deprecated; a better one replaces it.
- **Hygiene:** a lesson contains no customer data, object contents or credentials — only how to plan or how to
  use a tool. Before a version is published, the lessons pass an automatic check plus the owner's confirmation.
- **Example (from a test run):** "RuntimeListFeeds: request at most 100 records and page back with `to`; 1000
  overflows the model."

## 5. Assets

### 5.1 Information sources
- RAG collections (documentation, specifications, project rules, landscape description), uploaded files,
  possibly external knowledge bases. Mostly existing mechanics: collections, MANAGE upload, collection search.
- Attached to an agent or to a session; retrieved like the agent's lessons.

### 5.2 Extra MCP servers
- Tools beyond SAP (e.g. issue tracker, Git, SAP docs), attached in the WebUI to a session or an agent; workers
  see their tools next to the ABAP tools.
- **Security:** an MCP asset is connected only through a BTP destination, from an allowlist maintained by an admin
  — the hub never calls an arbitrary URL a user typed. Credentials live only in the destination or in request
  headers, never in the asset record, logs, the vector store or the planner context.
- Tool selection stays the LLM's decision ("better an extra tool than a missing one"); the tool-result cap and
  context-capture stats cover asset tools too.

### 5.3 Access when an agent is published
- An asset in an agent is a **reference**, not a copy. When someone uses a published agent, access to every asset
  is checked for that user; a private collection of the author is not opened to others.

## 6. Measuring agents

- The token usage ledger (`LLM_USAGE`, already designed) records the agent id and version per LLM call, so agents
  can be compared on similar tasks (cost, steps, failures). Context-capture stats name the asset/MCP that a tool
  came from.

## 7. Building blocks we already have

- User-scope persistent collections, server-side `rag_*` tools for workers, compact `rag_list` (8.8.0).
- Planner turn truth: `[tasks]`, `[actions]`, plan status, corrective turns (llm-agent 30.7.0).
- `[environment]` injection; skill managers in the hub (not wired to the planner yet).
- Tool-result cap and context-capture stats (8.6.0–8.7.0); BTP destinations for MCP.

## 8. Decisions for the owner

1. Who activates a draft lesson: the owner only, or also automatically when the same lesson recurs?
2. Publishing: snapshot versions only (proposed), or may a live collection be published as well?
3. Who may publish an agent (a dedicated role / admin only / any user to a chosen role)?
4. MCP assets: allowlisted BTP destinations only (proposed), or also other connection types?

## 9. Phasing (proposal)

1. Agent entity (profile + experience collection), pick at session start (WebUI + agent MCP), retrospective
   writing draft lessons, owner activation, injection of active lessons.
2. Assets: information sources attached to agent/session.
3. Publishing (snapshot versions, role access), attaching a published agent, base-agent inheritance.
4. MCP assets via allowlisted destinations.
5. Agent comparison via the usage ledger.
