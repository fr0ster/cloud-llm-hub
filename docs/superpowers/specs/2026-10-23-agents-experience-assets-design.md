# Agents: profile, experience, assets — design (draft)

Date: 2026-10-23. Status: draft; decisions in §8 taken 2026-10-23.
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
- **Two ways to publish.**
  - **Live:** the agent's current profile and experience are shared as they evolve.
  - **Snapshot version:** a frozen version (profile + experience + asset references). Sessions of other users
    never change it; the author releases new versions deliberately. Snapshots are what new agents are based on.
- **Who publishes.** A user with the dedicated publisher role, or an admin. Any other user may submit an agent
  for publication: it is listed as **unapproved** and becomes published once an admin approves it.
- **Access by role.** A published agent is visible to users with a given role (XSUAA role collections, as the
  hub already uses for admin).
- **Attach a published agent to a session.** Its experience and profile are read-only in that session; lessons
  from the session go to the user's own agent, never to the published one.
- **Base agent for training.** A new agent starts from a published **snapshot** as its base and adds its own
  layer on top. When a lesson in the own layer contradicts the base, the own layer wins.

## 4. Experience: lessons

- **Lesson record:** text (one or two sentences), subject (`planning` | `tool:<name>` | `system:<id>`),
  source system, created/confirmed counts, status `draft` | `active` | `deprecated`, agent id and version.
- **Storage:** a collection per agent, written with the existing server-side `rag_add` / `rag_correct` /
  `rag_deprecate`.
- **Quality:** a new lesson is `draft` and is not injected. It becomes `active` when the agent's owner or an
  admin confirms it.
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

### 5.2 Connections to external resources
- Not only MCP servers: any connection to an external resource (an MCP server with tools beyond SAP, an API,
  a knowledge base, a document store), attached in the WebUI to a session or an agent; workers see its tools or
  content next to the ABAP tools.
- **Admin-curated catalog:** connection assets are added by an admin once the resource is judged safe; users
  attach assets from that catalog, they do not register new endpoints themselves — the hub never calls an
  arbitrary URL a user typed. Credentials live only in the connection (e.g. a BTP destination) or in request
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

## 8. Decisions (2026-10-23)

1. **Lesson activation:** the agent's owner and admins activate draft lessons.
2. **Publishing:** both live publishing and snapshot versions; snapshots are the base for new agents.
3. **Publishing rights:** a dedicated publisher role and admins. Other users may submit an agent; it stays
   unapproved until an admin approves it.
4. **Connection assets:** not only MCP — any connection to an external resource. Assets are added by an admin
   when the resource is safe; users attach them from that catalog.

## 9. Phasing (proposal)

1. Agent entity (profile + experience collection), pick at session start (WebUI + agent MCP), retrospective
   writing draft lessons, owner activation, injection of active lessons.
2. Assets: information sources attached to agent/session.
3. Publishing (live and snapshot versions, publisher role, submit + admin approval, role access), attaching a
   published agent, base-agent inheritance from snapshots.
4. Connection assets from the admin-curated catalog.
5. Agent comparison via the usage ledger.
