# Design — RAG collection model (2026-09-10)

## TL;DR

Six collections, distinguished by **who fills them and when**. Two axes govern access:
**scope** (global / user / session) and **authorization** (public / role-gated). The
tool half shipped in v6.32.0; this design covers the rest — skills, user and session
collections, and the global ones that need a role.

And it settles the embedder question: without a vectorizing model **only the raw MCP
channel works**; every agent channel answers 5xx.

## The embedder is a per-channel requirement, not a global one

| Channel | Without an embedder |
|---|---|
| `POST /mcp/stream/http` | **works** — no RAG involved; the client selects tools itself |
| `POST /v1/chat/completions` | **5xx** — the text vectorization model is unavailable |
| `POST /v1/messages` | **5xx** — same |
| `execute_step` (`/mcp/agent/stream/http`) | **5xx** — same |

The agent cannot select tools without retrieval, so it must not pretend to. The raw
MCP proxy has no such dependency: it exposes the tool set directly and the connecting
client does the choosing.

**What changes:** `createToolsRagStore` currently falls back to keyword-only
`InMemoryRag` when `getOrCreateEmbedder()` yields nothing. That silent degradation
goes. The agent paths fail with a clear message naming the missing configuration; the
MCP path is untouched.

**Open — needs checking before implementation:** whether any deployed target actually
runs without an embedder today. `acme-sandbox` and `customer-b` use non-AI-Core providers
(`LLM_AGENT_PROVIDER=openai` / native Anthropic), and it is not yet established
whether they configure an embedding model separately. If one does, this change turns
a working deployment into 5xx, and it needs a migration note rather than a silent
switch.

## The six collections

| Collection | Filled | Purpose | Access |
|---|---|---|---|
| **tools · reader** | startup, from the embedding bundle | tools that change nothing | any MCP role |
| **tools · writer** | startup, from the bundle | tools that change something | `MCP_Developer` / `MCP_Full` |
| **skills** | startup, optionally, from disk | **configuration** — shapes prompt enrichment on every request | everyone |
| **user** | runtime, by the consumer through a tool, or by the LLM asked to save | that user's own material | its owner |
| **session** | runtime, same | same, shorter-lived | its owner, that session |
| **global** | **not by us** — already present in the vector DB | shared knowledge | a role that does not exist yet |

Two distinctions that are easy to lose:

- **Skills are configuration, not knowledge.** They are read on every request to build
  the prompt. That is why they are filled from disk at startup, are not written to at
  runtime, and are not role-governed.
- **Global collections are not ingested by us.** They exist independently. Our side is
  only the access decision — a role policy and collection selection, no ingestion.

## Two axes, not three

`shared` is a **value**, not an axis:

| Axis | Values |
|---|---|
| **scope** | `global` · `user` · `session` |
| **authorization** | public · role-gated |

A role-gated shared collection is `scope: global` plus an access policy. A physically
separate store is *how* the boundary is enforced, not evidence of another axis.

## Access is decided BEFORE the search, never after

For tools, retrieval filtering is the first of two lines — `assertToolAllowed` refuses
the call whatever retrieval offered. **Knowledge has no second line.** Nothing
executes; the content simply enters the prompt.

So collection selection is fail-closed and pre-query:

```
resolve caller's roles
  → list of collections this caller may search
  → query exactly those
```

Never "query everything, drop what they may not see". That shape is what failed for
tools and had to be rebuilt.

## Global scope has to be restored, and the reason it went matters

`global` is not merely absent — it was removed. `srv/rag-handler.ts` answers
`400 "global collections are no longer supported"`, and `srv/rag-collections.ts`
admits only `user | session`.

**The first task is finding out why it was dropped**, not re-adding it. That reason
may still hold, or may be exactly what a role policy now answers. Restoring it needs:

1. the scope model back to `global`
2. an access policy (role → collections) held **beside** `resolveExposition`, not
   inside it — a role that grants a knowledge collection is a different kind of answer
   than a tool-group level, and overloading the exposition groups would blur the two
   axes the design just separated
3. fail-closed pre-query selection, as above

The role itself does not exist yet. This design accounts for such collections without
creating the role.

## Skills: the unknown that sizes the work

We do not upsert skills — the **llm-agent builder** does, on every `build()`, into
whichever store it is handed. `ragStores` appears once in `agent-manager.ts`, and only
to read its keys.

So moving skills is not "redirect our upsert". It is "hand the builder a different
store", and **whether its API accepts one is unverified**. Settle that first; it
decides whether this is a contained change or an upstream conversation.

Related: `vectorizedSkillIds` exists because the builder re-vectorizes skills on every
`build()` — once per destination, against one shared store. It must be **rethought
rather than relocated**, or embedding calls return to the cold-start path that was
deliberately made embedding-free.

## Testing

- **Per-channel embedder requirement** — MCP path answers normally with no embedder;
  each agent channel answers 5xx with the configuration named.
- **Pre-query selection** — a caller lacking the role never queries the global
  collection. Assert on a query COUNTER, not on filtered results: the difference
  between this design and a post-filter is precisely that the store is not asked.
  (The tool-collection tests already do this; follow that shape.)
- **Skills reach every caller** regardless of role, and are not written to at runtime.
- **Cold start still loads from the bundle** — `Shared tool corpus ready (bundle)`,
  not a runtime vectorization. Silent when wrong: 6 seconds becomes 90.

## Not in scope

- Creating the role that gates global collections
- Ingesting global content
- Changing the tool split shipped in v6.32.0
