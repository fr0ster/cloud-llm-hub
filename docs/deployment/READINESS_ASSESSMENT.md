# Cloud LLM Hub — Reading the Readiness Questionnaire (Internal)

Internal companion to [READINESS_QUESTIONNAIRE.md](READINESS_QUESTIONNAIRE.md). The questionnaire
goes to the customer; this file stays with us.

**Do not merge the two files.** The questionnaire is deliberately free of links and of our
interpretation so it can be copied and sent as-is. The shared numbering (1.1, 2.3, …) is what keeps
them in sync — when you add a question there, add its row here under the same number.

Use this file to turn the returned answers into three outputs:

1. **Go / no-go** — are any hard blockers present?
2. **Scenario** — A, B, or C, as defined in [INSTALLATION_SUMMARY.md](INSTALLATION_SUMMARY.md).
3. **Effort** — the baseline estimate from that document, plus the adjustments below.

---

## 1. SAP BTP and Infrastructure

| # | Answer | What it means | Action |
|---|--------|---------------|--------|
| 1.1 | No subaccount | Not a blocker, but the critical path now starts at the Global Account admin | Add 1–5 days before anything else can begin |
| 1.1 | Unknown | Nobody on the customer side owns BTP yet | Find the owner before estimating anything; this often hides a much larger gap |
| 1.2 | CF not enabled | Enabling it is quick, but it needs the subaccount admin | Add a few hours; confirm CF runtime quota is entitled (1.4) |
| 1.3 | Region | Cross-check against data residency (3.4) and where the LLM runs | If the LLM region and the BTP region differ, raise it explicitly with Security |
| 1.4 | XSUAA, Destination, or CF runtime missing | **Hard blocker until fixed** — the app cannot deploy without these | Escalate to the Global Account admin immediately |
| 1.4 | Connectivity missing | On-premise SAP systems are unreachable | Blocker only if 4.2 says on-premise. Not available in trial accounts |
| 1.4 | AI Core missing | Scenario B | Requires answers to 2.4–2.6. The AI Core resource is already `active: false` in `mta.yaml` — simply do not activate it in `.mtaext`; there is nothing to switch off |
| 1.5 | Long entitlement lead time | The whole timeline shifts by that lead time | Start the entitlement request in parallel with everything else |
| 1.6 | Three environments | Roughly triples the deployment and role-assignment work, not the development work | Add ~2 hours per additional environment, plus its own destination, entitlements and CF runtime quota |
| 1.7 | No space, or no Space Developer | `cf deploy` fails at the last step, after everything else is ready | Cheap to fix but easy to forget — confirm the named person actually holds Space Developer before the install slot |
| 1.8 | Custom domain required | Extra service (Custom Domain) and certificate handling | Add 0.5–1 day and check the entitlement |
| 1.9 | Egress restrictions | Relevant only in Scenario B — an external LLM endpoint must be reachable from CF | Get the endpoint allowlisted before the deploy, not after |

---

## 2. LLM Provider and Models

| # | Answer | What it means | Action |
|---|--------|---------------|--------|
| 2.1 | AI Core available | **Scenario A** (default, lowest effort) | Confirm 2.2 and 2.3 — an entitlement without deployed models is not enough |
| 2.1 | No AI Core | **Scenario B** or self-hosted | Drive 2.4–2.7 |
| 2.2 | No models deployed | AI Core entitlement alone gets us nothing | One deployed chat model is enough to start; 1–2 hours. A separate classifier model is optional — without `LLM_AGENT_CLASSIFIER_MODEL` the main model is used. Do not quote it as a prerequisite |
| 2.3 | No embedding model | Tool-intent RAG cannot run in vector mode | Either deploy `text-embedding-3-small`, or fall back to `LLM_AGENT_RAG_TYPE: "in-memory"` with reduced tool-selection quality |
| 2.4 | OpenAI, Azure OpenAI, Anthropic, DeepSeek | **Scenario B** — supported out of the box | Needs `LLM_AGENT_PROVIDER`, `LLM_AGENT_API_KEY`, `LLM_AGENT_BASE_URL` |
| 2.4 | Self-hosted Ollama or vLLM | **Scenario B**, and it usually resolves compliance objections at 3.2–3.4 | Confirm it is reachable from Cloud Foundry — a laptop-local Ollama is not |
| 2.7 | Self-hosted model possible | The escape hatch when 3.2 forbids sending source to a hosted LLM | Confirm the hardware exists and that it is reachable from Cloud Foundry; otherwise it is not an option, only an intention |
| 2.6 | Native Anthropic or DeepSeek API | **Scenario B**, not C — `LLM_AGENT_PROVIDER` supports `anthropic` and `deepseek` natively, no adapter needed | Do not let "not OpenAI-compatible" push this into Scenario C. Anthropic's native API has no `/chat/completions` and is still supported. But it serves no `/embeddings` either — set `LLM_AGENT_RAG_TYPE: "in-memory"` and scope tool selection as keyword-only (see the note below) |
| 2.6 | Anything else, not OpenAI-compatible | **Scenario C** — requires an `ILlm` adapter | 1–2 weeks hands-on, 2–4 weeks wall-clock. Discuss with the team before committing to the customer |
| 2.1 + 2.4 | Neither AI Core nor any usable API | **Hard blocker** | No LLM, no agent. Only the plain MCP proxy surface would work |
| 2.5 | Customer will not share the API key | Key management has to be solved before deployment | Options: customer sets it in their own `.mtaext`, or a destination-based indirection. Clarify early |
| 2.8 | No budget owner for tokens | Predictable escalation right after go-live | Get a named owner and a rough monthly ceiling in writing |
| 2.9 | Tight rate limits | Concurrent users (5.5) may exceed them | Sanity-check: one agent request can trigger several LLM calls plus tool iterations |
| 2.10 | Model mandated | May conflict with what is actually deployed (2.2) | Verify the mandated model is available on the chosen provider before promising it |

> **Note for Scenario B — embeddings, not just chat.**
>
> - **TL;DR:** vector or `qdrant` RAG needs an embedder, and the tool vectors
>   for it are **built at deploy time**, not at startup.
> - **Default embedder:** for anything other than SAP AI Core it is OpenAI-style,
>   against the chat model's `LLM_AGENT_BASE_URL` and `LLM_AGENT_API_KEY`.
>   `LLM_AGENT_EMBEDDER`, `LLM_AGENT_EMBEDDER_URL` and `LLM_AGENT_EMBEDDER_API_KEY`
>   point it elsewhere (including `ollama`).
> - **Build step required:** the committed bundle (`srv/tool-embeddings.json`)
>   covers only the SAP AI Core embedder. Any other embedder needs
>   `tools/generate-tool-embeddings.ts` run for the target configuration —
>   `tools/deploy.sh` does it. Without it, every SAP request answers `503`
>   (`ToolCorpusMissingError`). See the
>   [migration note](../contributors/TOOL_CORPUS.md#migration).
> - **Native Anthropic or DeepSeek with no embedder elsewhere:** there is no
>   OpenAI-compatible `/embeddings` endpoint to use. Either point the embedder at
>   one (`LLM_AGENT_EMBEDDER_URL`, or `LLM_AGENT_EMBEDDER=ollama`) or set
>   `LLM_AGENT_RAG_TYPE: "in-memory"` — tool selection is then keyword-only; say
>   so when scoping.

---

## 3. AI Usage Permission and Compliance

This is the block that most often kills a deployment, and it is the one customers answer last. Push
for answers to 3.2 and 3.3 in the very first conversation.

| # | Answer | What it means | Action |
|---|--------|---------------|--------|
| 3.1 | No policy yet | The approval has no owner and no defined path | Expect weeks, not days. Ask who would own such a policy |
| 3.2 | ABAP code to an LLM not permitted | **Hard blocker for any hosted LLM** — reading source is the core of the product | Only a self-hosted model (2.7) makes the project viable. If that is impossible, stop here |
| 3.2 | Non-production systems only | Workable | Scope destinations to DEV and QA; do not configure a production destination at all |
| 3.3 | Business data not permitted | Read and analysis tools that return table contents, dumps, and logs are out | Restrict role collections to Reader; agree explicitly which tool groups are disabled |
| 3.4 | EU-only residency | Constrains both the BTP region (1.3) and the LLM | SAP AI Core in eu10 or eu11 satisfies this; a US-hosted OpenAI endpoint does not |
| 3.5 | No DPA with the vendor | Legal work on the critical path | Add 2–6 weeks wall-clock. SAP AI Core usually inherits the existing SAP contract — a strong argument for Scenario A |
| 3.6 | Review board required | Fixed lead time we cannot compress | Get the board's next slot date and plan backwards from it |
| 3.7 | Audit logging required | Not covered out of the box | Scope it as a separate work item — the honesty controller's notices are not an audit log |
| 3.8 | Security review required | Add it to the plan before production, not before the PoC | A PoC in a DEV subaccount can usually proceed in parallel |
| 3.9 | Must stay inside the corporate network | SAP BTP is out | Effectively a different product. Escalate before spending more time |
| 3.10 | Works council approval needed | Common in DACH; can take months | Find out early whether a limited PoC is exempt |

---

## 4. SAP Systems and Access

| # | Answer | What it means | Action |
|---|--------|---------------|--------|
| 4.1 | No system in scope yet | We can still deploy — UI and LLM work, MCP tools do not | Useful for an early demo. Set `LLM_AGENT_MCP_DESTINATION` later and redeploy |
| 4.2 | On-premise | Cloud Connector is on the critical path | Confirm 4.3; add 2–4 hours, more if the Cloud Connector team is a separate organization |
| 4.2 | SAP BTP ABAP environment | Simplest case — no Cloud Connector needed | Direct destination, Internet proxy type |
| 4.3 | Cloud Connector not registered for this subaccount | **Blocker for on-premise access.** Registration is per subaccount — an existing Cloud Connector for another subaccount does not count | Cloud Connector admin registers it; also needs access control for `/sap/bc/adt/**` |
| 4.4 | ICF service not activated | **Blocker** — no ADT, no tools | Basis activates `/sap/bc/adt` in SICF. That is the only endpoint the runtime uses. Usually fast once the right person is asked |
| 4.5 | No technical user | Blocker until created | Add 1–4 hours; in regulated environments this can require a formal request |
| 4.6 | Display-only authorizations | Read and analysis tools work; anything that writes fails at runtime with an authorization error | Match this to the role collections at 5.4 — do not hand out Developer if the backend user cannot write |
| 4.7 | Read-only required | Restricts us to Reader and Analyst role collections | Confirms a smaller, faster, easier-to-approve scope. Often the right first step |
| 4.8 | No package or namespace agreed | Object creation will fail on the first attempt | Agree a package before the first write test, not during it |
| 4.9 | Transport required | Every created object needs a transport request | Get a dedicated request for the PoC; otherwise every write stalls |
| 4.10 | Developer key needed | Object creation fails on on-premise systems without it | Basis registers the technical user as a developer |
| 4.11 | Principal Propagation | More setup than basic authentication, but per-user traceability | Add 2–4 hours and confirm the trust configuration exists |
| 4.12 | Change freeze | Constrains when we can test writes | Plan write testing outside the freeze, or restrict the PoC to read-only |

---

## 5. Users, Roles, and Operations

| # | Answer | What it means | Action |
|---|--------|---------------|--------|
| 5.2 | Corporate IdP | Trust configuration must exist in the subaccount | If it does not, add 0.5–2 days and a security-team dependency |
| 5.3 | Role assignment owner unclear | Users get deployed access on day two instead of day one | Name the owner during installation, not after |
| 5.4 | Access levels | Maps directly to the four role collections: MCP Reader Access, MCP Analyst Access, MCP Developer Access, MCP Full Access | Cross-check against 3.3, 4.6, and 4.7 — the narrowest of the three wins |
| 5.1 | User count and groups | Together with 5.4 this decides how many role collections and how much sizing headroom we need | Get per-group numbers, not a single total — a group is what a role collection is assigned to |
| 5.5 | High concurrency | Drives CF memory sizing and hits the LLM rate limits at 2.9 | The deployed baseline is 2 GB for the backend plus 512 MB for the approuter — a floor, not a target. It is already sized for a per-request heap spike; scale it against real numbers |
| 5.6 | Claude Code, Cline, or Claude Desktop | Each needs its own endpoint and token setup | See the optional steps in [INSTALLATION_PLAN.md](INSTALLATION_PLAN.md); add ~30 min per tool per user group |
| 5.7 | Customer operates it | They need handover documentation and build access | Add half a day of handover; make sure they can rebuild and redeploy without us |
| 5.8 | SLA required | A commercial commitment, not a technical one | Escalate — do not agree to an SLA inside a technical scoping call |
| 5.9 | Monitoring required | Cloud Logging or Alert Notification needs its own entitlement | Check it against 1.4 and add it to the entitlement request |
| 5.10 | Nobody owns updates | The instance freezes on the version we left behind, including security fixes | Name an owner and a cadence. If it is the customer (5.7), the handover must cover rebuild and redeploy, not just operation |

---

## 6. Commercial and Timeline

| # | Answer | What it means | Action |
|---|--------|---------------|--------|
| 6.1 | Proof of concept | Lets us skip 3.8, 5.8, 5.9 and often 1.6 | Push for a read-only PoC on DEV — it clears compliance fastest |
| 6.1 | Production rollout | Everything in blocks 3 and 5 becomes mandatory | Use the "from scratch at new customer" line of the effort table |
| 6.2 | Date earlier than the sum of the lead times | The plan is already unrealistic | Show the customer which dependency is the critical path — usually entitlements, Cloud Connector, or the AI review board |
| 6.3 | Budget owner or decision maker unnamed | Nobody can approve a scope change mid-project, and 2.8 has no escalation path | Get both names before scoping. This is separate from who pays for tokens (2.8) |
| 6.4 | Contacts missing | The single largest source of multi-day stalls | Do not start installation without a named contact for each dependency |
| 6.5 | Audits or freeze periods in the schedule | Narrows the window we can actually install and test in | Line them up against 4.12 — a BTP-side freeze and a SAP-side freeze rarely coincide |
| 6.6 | No defined path to production | The PoC will succeed and then stop | Worth surfacing before, not after, the PoC |

---

## Verdict

### Hard blockers

If any of these is true, the deployment does not proceed in its current form:

- **3.2** — ABAP source may not be sent to an LLM, and no self-hosted model is possible (2.7).
- **3.9** — the solution may not run outside the corporate network.
- **2.1 with 2.4** — no SAP AI Core (2.1) and no usable LLM API of any kind (2.4). Note that 2.6 is
  never a blocker on its own: it only chooses between Scenario B and Scenario C.
- **1.4** — XSUAA, Destination, or Cloud Foundry runtime cannot be entitled.
- **4.3 or 4.4 with 4.2 on-premise** — no Cloud Connector registration or no ADT, and no cloud system as an alternative.

Everything else is a delay, a scope reduction, or a scenario change — not a stop.

### Scenario selection

| Condition | Scenario | Baseline effort |
|-----------|----------|-----------------|
| 2.1 yes, with a chat model deployed (2.2) | **A** — SAP AI Core | ~2 h hands-on with everything ready |
| 2.1 no, and 2.6 is OpenAI-compatible **or** the native Anthropic or DeepSeek API | **B** — external or self-hosted provider | ~1.5 h hands-on with everything ready |
| 2.1 no, and 2.6 is any other interface | **C** — custom provider | 1–2 weeks hands-on, 2–4 weeks wall-clock |

The embedding model (2.3) does **not** select the scenario — it only decides whether tool-intent RAG
runs in vector or keyword-only mode. A customer with SAP AI Core and a chat model but no embedding
model is still Scenario A, deployed with `LLM_AGENT_RAG_TYPE: "in-memory"`.

Baselines and the full effort tables are in [INSTALLATION_SUMMARY.md](INSTALLATION_SUMMARY.md).
They assume every prerequisite is already in place — which is exactly what the questionnaire is
there to disprove.

### Effort adjustments

Start from the baseline, then add:

| Condition | Add |
|-----------|-----|
| No subaccount (1.1) | 1–5 days wall-clock |
| Entitlements missing (1.4) | The lead time from 1.5 |
| No models deployed (2.2) | 1–2 hours |
| Cloud Connector not registered (4.3) | 2–4 hours, plus the other team's queue |
| No technical user (4.5) | 1–4 hours |
| ICF not activated (4.4) | 1–4 hours |
| Corporate IdP trust missing (5.2) | 0.5–2 days |
| DPA to be signed (3.5) | 2–6 weeks wall-clock |
| Review board (3.6) | Its lead time, unavoidable |
| Custom domain (1.8) | 0.5–1 day |
| Each additional environment (1.6) | ~2 hours |
| Scenario C (2.6) | 1–2 weeks development before installation starts |

### Recommended first step

When compliance answers are slow or missing, the fastest viable entry point is a **read-only PoC on
a DEV system in Scenario A**: it needs no write authorizations (4.7), no transports (4.9), no
production data (3.3), and no security review (3.8), and it still demonstrates the product. Expand
scope once the answers arrive.
