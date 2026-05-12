# Tutorial Feedback — Tester Round, 2026-05-08

> Raw notes from external testers walking through the two RAP tutorials.
> Captured verbatim with light formatting; **interpretation / action items** appear in italics under each item so future tutorial revisions can be driven from concrete reports rather than memory.
>
> - **Tutorial 1** = [`rap-bo-creation.md`](../rap-bo-creation/README.md) — concrete Material Master walkthrough.
> - **Tutorial 2** = [`rap-bo-book-catalog.md`](../rap-bo-book-catalog/README.md) — AI-assisted Book Catalog (advanced).

---

## Tutorial 1 — CDS view creation flow

> "I struggled creating CDS views.
> **Interface views** got created only if I changed source table in CAPS in prompt — then it would create.
> For **projection views** I had to add in prompt to read that CDS back and then it would create; otherwise it was telling it is created but it even did not use any tool so it was not created. But when forced to read it, it did create at the end."

*Action: the AI silently claimed success without invoking any creation tool. Two reproducible workarounds the tester discovered:*
- *Source-table name in **UPPERCASE** in the prompt unblocks interface-view creation.*
- *Asking the AI to **read the just-created CDS back** forces actual creation when projection views first appear "created" but aren't.*

*Implication for tutorial: add a short "if the agent says created but you can't see the object" troubleshooting note in Step 6 / Step 7 of the simple tutorial, with both workarounds spelled out. Also worth filing upstream in `@mcp-abap-adt/llm-agent` — false-success on tool-less responses is a tool-routing bug, not a tutorial gap.*

---

## Tutorial 1 — Real-project usability assessment

> "Related to question 7. Yes, it could be used in real project(s).
> **Strengths:** really good for the beginning while creating domain objects, data elements, tables — for simple things, of course, as well as for whole simple project(s).
> **Limits:** more complex CDS view interfaces / consumption views, BO and BO behavior — it's a bit complex to use.
> Why complex: you must take care about syntax, signs (`'`, `\``, `"`, …) — you can omit or eat some chars; if you make a syntax error, the tool sometimes says yes it's okay, objects activated, no error… but when you check in Eclipse/ADT the situation is different. If you check and open some objects in Eclipse, the tool sometimes says (e.g. trying to recreate / activate after resolving an issue) the object is active when it still is not, or that it is locked and can't be changed. In this case the best is to close all open objects in Eclipse.
> **At the end:** really useful for everything — learning the LLM tool, practising RAP, finding solutions while making mistakes in the code."

*Action: the tutorial currently does not warn that ADT locks (Eclipse open editors) can desync the agent's view of object state. Add a sidebar / callout at the start of Phase 4 saying:*
- *Close all related objects in Eclipse before letting the agent activate.*
- *If the agent reports "active" but the object is locked, treat it as a false positive and verify in ADT.*

*Implication for the broader product: complexity ceiling is around BO + behavior definitions — same as the dump-monitor work has been hitting. Worth a roadmap line item for "tighten error reporting on activation operations".*

---

## Tutorial 2 — Non-determinism + AI-fixed errors regress

> "AI response is not same every time (as expected) and it is difficult to control the flow as mentioned in the tutorial. Additionally if the response provided by AI is good and working then it is fine; if it is not proper, then rectifying the error with AI is creating more issues. If an error occurs it is better to rectify it with your own expert knowledge.
> In my case I have generated the code (which saves time) but it is not performing CRUD operation, which needed to be fixed manually."

*Action: the Book Catalog tutorial sells a tightly-controlled phase-by-phase flow, but real runs diverge. Two specific tweaks:*
- *Soften the "AI controls the flow" framing in the intro — explicitly call out that retries / corrections may take you backwards if the AI is iterating on its own mistakes. Recommend: when the AI gets stuck on a specific symptom for >2 rounds, switch to manual fix.*
- *Add a worked example of the "generated code compiles but CRUD doesn't actually run" failure mode and how the tester eventually got to a fix. This is the most actionable part of the feedback — without a concrete reproducer, future testers will hit the same wall.*

---

## Tutorial 1 — Metadata extensions on child consumption views

> "To make the app completely operational, had also to add metadata extensions for child CDS consumption views (otherwise could not fill data there)."

*Action: the simple tutorial currently shows metadata extensions only for the root projection. Extend Step 8 (or a new Step 8b) covering metadata extensions for the child consumption views (`Z##_C_MAT_PLANT`, `_TEXT`, `_SALES`) so the app actually shows their data on the Object Page facets. Without this the runtime UI looks half-broken and the tester lands a bug they have to debug from scratch.*

*Implication: the skill reference in `docs/tutorials/rap-bo-book-catalog/skills/rap-bo-creation.md` should also mention "every projection view that appears as a facet needs its own metadata extension". Currently the rule is implicit.*

---

## Open follow-ups (not blocking — track separately if we act)

1. **Tool-routing false positives.** Two of the four items above describe the AI claiming success without invoking the creation tool. This is the same class of bug the tester hit twice on Tutorial 1 (interface views, projection views). Worth a focused investigation in `@mcp-abap-adt/llm-agent` rather than tutorial wording fixes.
2. **Eclipse/ADT lock interplay.** Worth documenting once globally (e.g. in `AI_PAIR_PROGRAMMING_PRINCIPLES.md` "When things go wrong" section) instead of restating in each tutorial.
3. **CRUD code that compiles but doesn't act.** Needs a concrete repro before we can say whether it's a generation problem (agent omitted `MODIFY`/`READ` handlers), an activation problem, or a binding problem. Ask the tester for the failing prompt + final code if possible.
