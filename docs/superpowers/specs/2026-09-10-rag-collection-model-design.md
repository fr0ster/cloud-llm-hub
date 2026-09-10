# Design — RAG collection model (2026-09-10)

<!-- docs-check:proposed-env — this spec names configuration that does not exist yet -->

## TL;DR

Six collections, distinguished by **who fills them and when**. Two axes govern access:
**scope** (global / user / session) and **authorization** (public / owner / role). The
tool half shipped in v6.32.0; this design covers the rest — skills, user and session
collections, and the global ones that need a role.

And it settles the embedder question: without a vectorizing model **only the raw MCP
channel works**; every agent channel answers 5xx.

## The embedder is a per-channel requirement, not a global one

**Owner's decision:** without a vectorizing model only the raw MCP channel serves;
every agent channel answers 5xx.

| Channel | Without an embedder |
|---|---|
| `POST /mcp/stream/http` | **works** — no retrieval involved; the client selects tools itself |
| `POST /v1/chat/completions` | **5xx**, naming the missing configuration |
| `POST /v1/messages` | **5xx** |
| `execute_step` (`/mcp/agent/stream/http`) | **5xx** |

**This is a quality decision, not a technical impossibility.** An earlier draft here
claimed the agent "cannot select tools without retrieval" — that is false.
`InMemoryRag` performs real keyword retrieval, and `LLM_AGENT_RAG_TYPE=in-memory` is
a documented mode. The actual argument is that keyword-only selection over a
360-tool corpus is not good enough to stand behind: tool descriptions are
paraphrases of intent, which is what vectors match and keywords do not.

So the change is: stop serving agent requests at a quality we do not accept, and say
so explicitly rather than degrade silently. `createToolsRagStore` currently falls back
to `InMemoryRag` when `getOrCreateEmbedder()` yields nothing; on the agent paths that
fallback goes.

**Compatibility, settled:** `acme-sandbox` reaches the same AI Core, so it is
unaffected. `customer-b` is out of scope. No other target runs without an embedder, so no
migration note is required — but the implementation should still verify each target's
embedder configuration before the switch rather than trusting this line.

## The six collections

| Collection | Filled | Purpose | Access |
|---|---|---|---|
| **tools · reader** | startup, from the embedding bundle | exposition groups `readonly`, `search`, `system` | any MCP role |
| **tools · writer** | startup, from the bundle | exposition groups `high`, `compact`, `low` | `MCP_Developer` / `MCP_Full` |
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
| **authorization** | `public` · `owner` · `role` |

`owner` is **implied by scope and not configurable**: a `user` collection is reachable
by its owner, a `session` collection by its owner within that session. There is no
setting that opens someone else's collection to a role — ownership and role are
answers to different questions, and mixing them would let a role read private
material.

Configurable policy therefore applies to `global` collections only: they are `public`
or `role`-gated. A role-gated shared collection is `scope: global` plus that policy. A
physically separate store is *how* the boundary is enforced, not evidence of another
axis.

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

### Operational contract

"Already in the vector DB, we only select" is not enough to build from. Six questions,
answered:

**Where the catalogue comes from.** A declared list in configuration — a **proposed,
not-yet-existing** env var (working name: `LLM_AGENT_GLOBAL_COLLECTIONS`), holding a
JSON array of `{ physicalName, displayName, requiredRoles }`. Not discovery from the
backend: discovery would make the set of
readable collections depend on what happens to exist in the database, which is the
opposite of fail-closed. If it is not declared, it does not exist for us.

**How collection → roles is expressed.** In that same entry, `requiredRoles: []` means
public; a non-empty list means the caller needs **at least one** of them. The list is
role NAMES, resolved against the caller's XSUAA roles directly — not through
`resolveExposition`, which answers in tool-group levels and must not learn about
knowledge.

**An unknown collection.** Refused. A name not in the declared catalogue is not
searched, whatever the request says.

**An unknown role in `requiredRoles`.** The collection becomes unreachable, and this
is logged at startup as a configuration error. A role nobody can hold is fail-closed
by construction, but silently so — hence the log.

**Attaching to an existing backend collection.** The registry gains a read-only
attachment path: given `physicalName`, bind to it without creating or migrating.
`CollectionMeta` grows `scope: 'global'` and `requiredRoles`. Note that the Qdrant and
HANA backends are placeholders today, so the first implementation targets whichever
backend actually holds this content — establish that before writing code.

**Metadata visibility.** The listing API shows a global collection's `displayName` and
whether the caller may search it — never its contents, and never collections the
caller cannot reach. Ingestion being external does not make the catalogue secret, but
it does not make it public either.

None of this creates content or roles; it is the resolver's contract.

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
