# Design — RAG collection model (2026-09-10)

<!-- docs-check:proposed-env — this spec names configuration that does not exist yet -->

## TL;DR

> ## ⛔ BLOCKED — roles do not resolve correctly in production
>
> Observed 2026-09-10 on `acme-prod` prod, and **not** specific to the WebUI —
> it reproduces on other channels too. This design assumes the caller's roles reach
> collection selection. Right now they do not, so it must not go to implementation
> until the cause is known.
>
> **The anomaly, from the prod log (`mcp-manager`), six occurrences:**
>
> ```
> Resolved MCP exposition for user roles {
>   roles: [ 'MCP_Analyst' ],
>   exposition: [ 'readonly', 'search', 'system' ]
> }
> ```
>
> **That combination cannot exist under our own configuration.** `xs-security.json`
> was checked and is correct: every role template includes the ones below it —
> `MCP_Analyst` grants scopes `MCP_Reader` **and** `MCP_Analyst`. So
> `user.is('MCP_Reader')` returning false while `user.is('MCP_Analyst')` returns true
> is not something role assignment can produce.
>
> Both channels filter identically (`allMcpRoles.filter(r => user?.is?.(r))` in
> `mcp-manager.ts:339`, `resolveExpositionForUser` on the chat path), so the fault is
> upstream of our filtering — in the token, or in how CAP derives roles from scopes.
>
> **Ruled out:**
> - role assignment — the user holds all eight collections (4 prod + 4 staging)
> - a stale token predating assignment — would not drop `MCP_Reader` selectively
> - a different `xsappname` — the user works on prod with prod collections assigned
> - our filtering code — identical on both channels, and it reads what it is given
>
> **Next step:** decode a live token from `GET /v1/token` and compare its `scope`
> array against what `user.is()` answers for each of the four roles, in the same
> request. That is the only place the two views meet.
>
> **Fix observability first:** the chat channel logs no roles at all — only
> `mcp-manager` does. Add the same line beside `callerExposition` in
> `openai-handler.ts`. It changes no behaviour and is the difference between
> diagnosing this and guessing at it.


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
so explicitly rather than degrade silently.

### How that is actually enforced

Removing the `getOrCreateEmbedder() === null` fallback is **not sufficient**, and an
earlier draft implied it was. That function returns null only for
`LLM_AGENT_RAG_TYPE=in-memory`. In vector mode the embedder client is constructed
without ever checking the model is reachable, and `FallbackRag` then degrades to the
keyword store on embedding failures — so a missing or unreachable model still yields
answers, just quietly worse ones. Four decisions:

**Default.** `LLM_AGENT_RAG_TYPE` defaults to `vector`. `in-memory` remains
selectable and is honest about what it is: with it set, the agent surfaces are
disabled by the same rule below. It stays useful for unit tests and for the MCP-only
deployment shape.

**Readiness, not construction.** At startup, and on the destination-init path, embed a
fixed canary string. Success marks the embedder healthy; failure marks it unhealthy
with the reason. This is what the agent surfaces consult — not whether a client object
exists.

**FallbackRag keeps failing over, but not into a lie.** Its keyword fallback stays for
resilience *within* a request, since a half-answer beats a dropped one mid-conversation
— but a fallback event flips the embedder to unhealthy, so the NEXT request is refused
rather than silently served at keyword quality. Degradation becomes visible instead of
permanent.

**The contract on refusal.** All three agent surfaces answer **503** — the condition is
transient by nature, and 503 tells a client to retry rather than to change its request:

| Surface | Shape |
|---|---|
| `/v1/chat/completions` | `{ error: { message, type: 'service_unavailable', code: 'EMBEDDER_UNAVAILABLE' } }` |
| `/v1/messages` | `{ type: 'error', error: { type: 'api_error', message } }` |
| `execute_step` | tool error carrying the same message |

The message names the missing configuration (`AICORE_*` or `LLM_AGENT_EMBEDDING_*`)
and the failure reason from the probe. `/mcp/stream/http` and `/health` are unaffected
— an embedder outage must not make the MCP proxy look down.

**A transient outage does take the agent down for its duration.** That is the intended
trade: better a retryable 503 than answers selected by keyword match over 360 tools
without anyone knowing.

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
JSON array of `{ backend, physicalName, displayName, requiredRoles }`. Not discovery
from the backend: discovery would make the set of
readable collections depend on what happens to exist in the database, which is the
opposite of fail-closed. If it is not declared, it does not exist for us.

**How collection → roles is expressed.** In that same entry, `requiredRoles: []` means
public; a non-empty list means the caller needs **at least one** of them. The list is
role NAMES, resolved against the caller's XSUAA roles directly — not through
`resolveExposition`, which answers in tool-group levels and must not learn about
knowledge.

**An unknown collection.** Refused. A name not in the declared catalogue is not
searched, whatever the request says.

**What counts as a known role.** The authoritative catalogue is the bundled
`xs-security.json` — its `role-templates`, which is what BTP can actually assign. A
name outside that set is unknown, including the future global-access role until it is
added there. That keeps one source of truth rather than a second list drifting beside
it.

**An unknown role in `requiredRoles`.** The collection becomes unreachable, logged at
startup as a configuration error. A role nobody can hold is fail-closed by
construction, but silently so — hence the log.

**Schema validation, fail-closed.** `requiredRoles` is validated per entry:

| Value | Meaning |
|---|---|
| explicitly `[]` | public |
| non-empty array of known roles | at least one required |
| **missing, `null`, not an array, or containing an unknown role** | **unreachable** |

Note the asymmetry, and that it is deliberate: absent is *not* the same as empty.
Empty means someone decided this is public; absent means nobody decided anything. A
malformed or half-parsed entry must never open a collection, which is exactly what
would happen if the two were treated alike. A rejected entry is logged with the reason
and the collection stays out of every caller's list.

**Which backend, and how it attaches.** `backend` is **explicit in the entry**
(`'qdrant' | 'hana'`) and never inferred: the same `physicalName` can exist in more
than one provider, and guessing would make the choice depend on registration order.

Attachment is **read-only**: given `(backend, physicalName)`, bind to an existing
collection — never create it, never migrate it, never write to it. If the named
backend is not registered, the collection is unreachable and that is logged at startup
as a configuration error, exactly like an unknown role.

`CollectionMeta` grows `scope: 'global'`, `backend`, and `requiredRoles`.

**Both backends are placeholders today** — neither is registered. So the first
implementation must register the one that actually holds this content, and that choice
is a prerequisite of this work rather than part of it: it decides which client, which
auth, and which deployment binding. Settle it before writing the resolver.

**Metadata visibility.** The listing API returns **only the collections this caller
may search**, with `displayName` and `scope` — never contents. An earlier draft also
carried a "may the caller search it" flag, which in such a list is always true; the
flag is dropped rather than the filtering, because showing a name a caller cannot use
leaks the catalogue for no benefit.

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
