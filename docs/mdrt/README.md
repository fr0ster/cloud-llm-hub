# AI SDLC Demo — prep notes

> Working notes for a customer demo on AI-assisted SAP development: what cloud-llm-hub does today, and what's worth showing in a 30-minute slot.
> Client-neutral — no names, no personal data, no production identifiers.

## Who this is for

The request came from the **project lead**, addressed both to me as a **developer** and to my **manager**, who looks at the project from the **business side**. So each topic is written for both:

- **Value** — one line, business angle: why the customer cares (for the manager).
- **Possible / proof / demo prep** — the technical side: can we do it, what backs it, how much setup (for me).

## Short version

- Ready and demo-ready today, lead with these: **dump analysis, code review, reasoning across many programs**. Low prep.
- **Log interpretation** (billing-run / VFX3): possible, same pattern as dump analysis (domain skill + agent reads the real log). Needs prep.
- **SAP Notes search**: possible via RAG over an ingested set of Notes, not a live crawl. Needs prep.
- **Joule**: different tools for different jobs. Keep it gentle, no claims about what Joule does or doesn't do.
- "What else?" idea: **repeat-ticket detection** — we already do a small version of it.

## Files

| File | What it's for |
|------|---------------|
| [`capabilities-vs-feedback.md`](capabilities-vs-feedback.md) | Per topic: possible? what proves it? how much prep? |
| [`demo-plan.md`](demo-plan.md) | 30-minute run-of-show + pre-flight checklist |

## Tags

| Tag | Means |
|-----|-------|
| ✅ **Ready** | Works today, tutorial/example proves it. Safe live. |
| 🟡 **Feasible** | Pieces exist; needs prep before a clean live demo. |
| 🔵 **Roadmap** | Grounded in what we've built, not a feature yet. Pitch as next step. |

## Topics

1. Short dump analysis
2. Code review
3. Analysis & code proposals across many methods/programs, not one report
4. How we sit next to Joule (e.g. incomplete order data → suggested fixes)
5. Billing-run / VFX3-style log interpretation
6. Other AI-driven use cases
7. SAP Notes search — is an issue already known
8. Mining historical tickets for recurring same-root-cause issues
