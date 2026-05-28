# 30-minute run-of-show

> Details behind each topic: [`capabilities-vs-feedback.md`](capabilities-vs-feedback.md).
> Client-neutral — no names, no personal data, no production identifiers.

## Timing

| When | What |
|------|------|
| 0–2 min | Framing — what cloud-llm-hub is: an LLM agent that reads and reasons over the real ABAP system, with a knowledge base behind it. |
| 2–9 min | **Dump analysis**, live. |
| 9–16 min | **Code review**, live — end on the severity-ranked report. |
| 16–22 min | **Across many programs**, live — the usage map. |
| 22–27 min | Needs-prep topics — logs, SAP Notes, a light word on Joule. |
| 27–30 min | Repeat-ticket detection + questions. |

Keep ✅ topics live. Keep 🟡/🔵 as a slide plus a short illustration. Don't run anything live we haven't checked on the demo system first.

## Pre-flight

- [ ] Confirm the demo **destination** and that the proxy/approuter points at the right system.
- [ ] Find **one dump** to diagnose.
- [ ] Pick **one legacy report** for the code review.
- [ ] Pick **one package/mechanism** for the cross-program usage map.
- [ ] Logs: write the **domain skill** and grab **one real log**.
- [ ] SAP Notes: pre-load a **small set of relevant Notes** — only if we commit to showing it.
- [ ] Decide the **one** extra closer (doc generation or test generation).

## Per segment

**Dump analysis (live).** Pull a dump, read the stack and failing class, explain the cause, propose the fix. Mention the hands-off version (watch → analyze → ticket) without running it.

**Code review (live).** Run the four-angle review on the chosen report; end on the severity-ranked summary + slide deck.

**Across many programs (live).** Ask "where/how is X used across this package?"; let it fan out into one consolidated map.

**Needs-prep topics (slides + light touch).**
- *Logs (billing/VFX3):* domain skill + agent fetches the real log (on-prem tables, throwaway TMP class, or pasted log).
- *Joule:* gentle — different tools, different jobs; soft "use both", no claims about Joule's scope.
- *SAP Notes:* match an error to a Note from an ingested set; state it's a loaded set, not a live crawl.

**Closer.** Dump-recurrence behavior as proof, then pitch the ticket-history version (cluster by root cause, surface prior fix).

## What we won't claim

- No one-click billing/VFX3 log reader — skill + log-access path, set up per domain.
- No live search across every SAP Note — RAG over an ingested set.
- Nothing about replacing Joule.
- Nothing live we haven't checked beforehand.
