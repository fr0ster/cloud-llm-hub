# Presenter Guide — Cloud LLM Hub on `<SYSTEM>` (30-minute slot)

> **Template.** Copy to `docs/demo/systems/<subaccount>-presenter.md` on the matching deploy branch and replace every `<PLACEHOLDER>`. Live examples: see `deploy/epam-sap-mcp` branch.
>
> Placeholders:
> - `<SYSTEM>` — human-readable system name (e.g., `S/4HANA E19`).
> - `<SUBACCOUNT>` — CF org identifier suffix (e.g., `epam-sap-mcp-450kjhsb`).
> - `<DESTINATION>` — BTP destination name (e.g., `S4HANA_E19`).
> - `<PACKAGE>` — demo ABAP package (e.g., `TEST_MCP_DEMONSTRATE`).
> - `<CLASS_GOOD_A>`, `<CLASS_GOOD_B>`, `<CLASS_BAD_A>`, `<CLASS_BAD_B>` — well/badly designed classes created by `scripts/demo-epam/prepare-landscape.sh` (names follow `ZCL_MCP_DEMO_*`).
> - `<APPROUTER_URL>` — local chat UI URL (e.g., `http://localhost:3001/chat/webapp/index.html`).
> - `<MAIN_MODEL>`, `<CLASSIFIER_MODEL>` — model names visible in the UI status bar.
> - `<RAG_DOC>` — a support-case Markdown path inside `docs/demo/rag-content/` to inject during Act 4.
>
> After replacing, delete this preamble.

Accompanies [`<SUBACCOUNT>.md`](./<SUBACCOUNT>.md) (full act reference). Use this file as the single scrollable source during the talk.

**Thesis:** AI pair-work beats "make it for me" vibecoding. The agent is a capable junior; you stay the reviewer and the curator.

---

## Pre-flight (do 5 minutes before you start)

1. **CF target** — `cf target -o '...<SUBACCOUNT>' -s dev`.
2. **Proxy** — new terminal, `npm run proxy <DESTINATION>`. Expected: `proxying :3001 → https://...`.
3. **Landscape ready** — `bash scripts/demo-epam/prepare-landscape.sh`. Expected: `all objects created and verified in package <PACKAGE>`.
4. **Browser** — open `<APPROUTER_URL>` in an **incognito window** with a fresh service key. If auth returns 500/WrongAudienceError, `cf create-service-key cloud-llm-hub-auth mcp` → `npm run get:key` → copy `mcp.json` to `~/.config/mcp-abap-adt/service-keys/mcp.json` → restart proxy.
5. **Optional** — SAPGUI/ADT on `<SYSTEM>` open in background for visual confirmation of activated objects.
6. **Keep in the other hand** — this document; full act reference; `docs/demo/rag-content/` for Act 4.

Cleanup prompt to keep at hand: *"Delete package `<PACKAGE>` and all its objects on destination `<DESTINATION>`."*

---

## 0:00–0:02 — Opening

Read out loud, slow:

> "I'm going to show a 30-minute pair session with an AI that has full read/write access to an on-premise SAP system through MCP. The point is not 'AI does my job' — the point is dialogue. I talk to the agent, it proposes, I steer. If I just said 'build me a module' and walked away, you'd watch me fail. So let's do it properly — as a pair."

Click into chat UI, confirm model is `<MAIN_MODEL>`, destination `<DESTINATION>`, classifier `<CLASSIFIER_MODEL>`.

---

## 0:02–0:08 — Act 1: Discovery + Compare

**Opening prompt (paste as-is):**

> List all objects in package `<PACKAGE>`. Then compare classes `<CLASS_GOOD_A>` and `<CLASS_BAD_A>` side by side on: decomposition, mutable state, input validation, SQL safety. Use a markdown table.

**Presenter notes:**
- Let the agent call `GetPackageContents` first — point out the `[SmartAgent: Executing ...]` trace. That's the real work.
- Read 2 rows of the comparison table aloud — "every claim cites something from the source; this is not a general opinion."
- Move on while it still feels fresh.

**Stay ~6 min, max 7.** If the agent stalls on a read, nudge: *"continue with the second class."*

---

## 0:08–0:14 — Act 2: Security Review with a Skill

**Opening prompt:**

> Follow the abap-code-review skill and review `<CLASS_BAD_B>`. Group findings by severity. Every finding must cite a line and quote ≤3 lines of actual source.

**Presenter notes:**
- Talk over the agent while it fetches: *"A generic LLM would give you 'consider using OOP' — useless. The skill forces line-cited, severity-graded findings. This is auditable output."*
- Highlight one Blocker and one Major aloud.
- If the agent hallucinates a line number, surface it live: *"I'm checking. The skill helps us catch this."*

**Stay ~6 min.** If review feels shallow, push once: *"re-read the source and add anything you missed."*

---

## 0:14–0:22 — Act 3: Live Refactor Dialog (write-back on SAP)

Four short turns. Do **not** paste them all at once — wait for each answer, react naturally.

**Turn 1:**
> Propose a decomposition plan for `<CLASS_BAD_B>`. Extract each anti-pattern into its own method with a focused signature. No code yet — just the plan as a bullet list.

**Turn 2 (after the plan):**
> Good. Now pick the most critical path. Write a clean replacement method with proper error handling and any required authorization. Show me the source only — do not create it yet.

**Turn 3 (after code):**
> Create a new class `<CLASS_GOOD_B>_V2` in package `<PACKAGE>` with this single method. Activate it and confirm.

**Turn 4 (after activation):**
> Now read the class back and show me the full source as it exists on `<SYSTEM>`.

**Presenter notes:**
- This is the money act. Highlight aloud:
  - *"I didn't run git, I didn't open ADT — this landed in the transport of a real SAP system."*
  - *"Every step is a short prompt. The agent does the thinking, I do the reviewing."*
- If activation fails, treat it as a live feature: *"Good, SAP caught it before we did. Let's fix."* — feed the error back; the agent usually corrects in one round.

**Hard ceiling 8 min.** Skip Turn 4 if activation eats time.

---

## 0:22–0:26 — Act 4: RAG Moment (live knowledge injection)

**Before the talk:** have `<RAG_DOC>` content copied into your clipboard.

**Opening prompt:**

> A colleague says a report suddenly returns all rows instead of the filtered subset. Have we seen this before?

**Presenter notes:**
- First answer will likely be generic — use that. *"It doesn't know this yet. Let me teach it, live."*
- Inject `<RAG_DOC>` via the RAG mechanism the UI exposes (or describe the usual ingestion path).
- Ask again:
  > Same question. Has it happened before?
- Agent should now retrieve the case and answer with the exact fix.
- Call out: *"That's the power — we own the knowledge base. The model is just the engine."*

**Stay ~4 min.** If ingestion glitches, skip to Q&A.

---

## 0:26–0:30 — Q&A + close

Mention cleanup intent (`"I'll tear down <PACKAGE> after the session"`), then open Q&A.

### FAQ — prepared short answers

**Q: Doesn't it hallucinate?**
> It can. Every tool call prints `[SmartAgent: Executing ...]` in the response — no trace, no real work. Our skill forces line-cited quotes. When fabrication shows up, we surface it on screen — the demo was live, not edited.

**Q: How do we audit what the AI did?**
> Three layers. One: request + tool trace logged per correlation ID. Two: every write ends up in a SAP transport — same audit as a human developer. Three: RAG retrieval is logged with provenance — we know which document backed any grounded claim.

**Q: Write access into production? Really?**
> Not into production. Role-based exposition: a reader role gets only `Get*` tools, a developer role gets create/update for their packages. XSUAA token controls what the agent is allowed to even see. Today's demo runs as an MCP Full role in the dev tier.

**Q: What about cost?**
> Small classifier (`<CLASSIFIER_MODEL>`) routes; large model (`<MAIN_MODEL>`) only runs when reasoning is needed. Most RAG and dispatch calls never reach the big model. Per-session spend runs cents, not dollars.

---

## Backup — if something breaks live

- **MCP 500 / WrongAudienceError:** *"service key rotated — in production we automate the handshake."* Run `cf create-service-key cloud-llm-hub-auth mcp`, `npm run get:key`, restart proxy. If >60 s, fall through to FAQ; do not debug live.
- **Destination unreachable:** agent says so explicitly. Pivot to Act 4 (RAG) — no SAP required.
- **Proxy refuses to start:** show the command (`npm run proxy <DESTINATION>`), explain URL resolution via `cf app`, move on.

Tip: always have `http://localhost:3001/v1/models` pre-loaded in a tab — if JSON, stack is alive; if 500, the chat UI won't save you.
