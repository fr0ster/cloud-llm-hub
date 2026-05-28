# What we can do for each topic

> Per topic: **Value** (business angle, for management) + possible / proof / demo prep (technical).
> Tags: ✅ Ready · 🟡 Feasible · 🔵 Roadmap (see [README](README.md)).
> Written to be readable without access to our repository — "proof" means working examples we've already built, not internal links.

---

## 1. Short dump analysis — ✅ Ready

**Value:** faster incident resolution — root cause and fix in minutes instead of a developer reading dumps by hand.

Possible today. The agent fetches the dump, reads the failing class/program, walks the call stack, and explains the cause and fix.

Proof: we've built two working examples — one takes an SAP Cloud ALM alert and returns a structured diagnosis, the other watches for new dumps on its own, analyzes each, and opens (or updates) a Jira ticket.

**Demo prep:** low — pick one dump on the demo system, run it live.

---

## 2. Code review — ✅ Ready

**Value:** consistent quality gate — security, performance and CleanCore issues caught before go-live, with a report management can read.

Possible today. The agent reviews one object across four angles — security, performance, CleanCore compliance, maintainability — and produces a severity-ranked report plus a slide deck.

Proof: we have a worked-through review process for this, and it uses read-only access only (it never changes the system).

**Demo prep:** low — pick one legacy report, run it live.

---

## 3. Across multiple methods/programs — ✅ Ready

**Value:** handles real change scope — impact and proposals across a whole feature/package, not one isolated report. Directly answers the "single report or more?" question.

Possible today. Not limited to one object — it reasons across the whole codebase.

Proof: we have a worked-through analysis process that tracks how a mechanism is used across many programs and classes and builds a usage map of every place it appears.

**Demo prep:** low — ask "where/how is X used across this package?" and let it fan out live.

> Internal note (for us): keep the package-wide source scan sequential, not parallel — it's a heavy backend scan.

---

## 4. Next to Joule — 🟡 Feasible

**Value:** clears the "do we already have this in Joule?" worry — positions cloud-llm-hub as complementary, protecting the project's reason to exist.

Possible (the order-data case): read the order and its incompletion data, read the relevant logic, and reason about the missing fields and the fix.

On positioning: different tools for different jobs. Keep it gentle — soft "use both", no claims about what Joule does or doesn't do.

**Demo prep:** needs prep — pre-script one concrete incomplete-order scenario rather than improvising.

---

## 5. Log interpretation (billing-run / VFX3-style) — 🟡 Feasible

**Value:** turns cryptic operational logs into plain cause + next step — less time stuck, less dependence on the one expert who "knows that log".

Possible, same pattern as dump analysis: a reusable **skill** carries the domain knowledge (what a billing/VFX3 run is, its message classes, common failures) and the agent fetches the real log. It can read the log tables on the system, build a small throwaway analysis program for one specific log and run it, or explain a pasted log line by line.

**Demo prep:** needs prep — write the domain skill and confirm the log-access path on the target system.

---

## 6. SAP Notes search — 🟡 Feasible

**Value:** avoids re-solving problems SAP already documented — check "is this known?" before spending effort.

Possible via RAG: ingest the relevant SAP Notes into a knowledge collection, then the agent searches them by meaning and links an error to the matching Note. The platform already supports this kind of knowledge collection. No live crawl of all Notes — only the ingested set.

**Demo prep:** needs prep — pre-ingest a small set of relevant Notes.

---

## 7. Other use cases

**Value:** shows the platform isn't a one-trick demo — same engine covers docs, scaffolding, tests, performance.

Extras grounded in what we've already built:

| Idea | State |
|------|-------|
| Documentation generation for legacy code | ✅ |
| RAP business object scaffolding from a spec | ✅ |
| Unit-test generation (ABAP + CDS) | 🟡 |
| Performance analysis from profiler traces | 🟡 |
| Enhancement / BAdI impact analysis | 🟡 |
| Spec-draft analysis before estimation | ✅ |

**Demo prep:** pick one as a closer; don't show all of them.

---

## 8. Repeat-ticket detection — 🔵 Roadmap

**Value:** the strongest "additional value" pitch — cut resolution time by reusing past fixes instead of re-diagnosing recurring issues.

The idea: find tickets that recur with the same root cause and surface the prior fix, to cut resolution time.

Grounded in what exists: our dump monitor already recognizes a recurring dump and comments on the existing ticket instead of opening a new one. Generalize that — ingest ticket history, cluster by root-cause signature — and you get "this matches a known cluster, here's last time's fix."

**The concrete open question — where the tickets come from.** This is the part we need to settle with the customer before it's real, because it decides the whole effort:

- **Which system holds the tickets?** SAP Solution Manager / Focused Run, SAP Cloud ALM, ServiceNow, Jira Service Management, or something else. Each has its own export/API.
- **How do we get them out?** Most expose a REST/OData API or a CSV/Excel export. We pull tickets (and their resolution notes) on a schedule into a knowledge collection — read-only, no write-back needed.
- **Which fields drive the clustering?** Short text, long text/description, component/application area, error or message codes, and the resolution note. The resolution note is the valuable bit — that's the "here's how it was fixed" we want to surface.
- **What's in scope for personal data?** Ticket text can contain names, user IDs, customer references. We agree up front to strip/anonymize those on ingest — consistent with how we keep this whole topic client-neutral.

Once those are answered, the build is small: scheduled export → ingest into a collection → cluster by signature → match new tickets. The unknown is access and data, not the AI.

**Demo prep:** show the dump-recurrence behavior as proof of the mechanism; pitch the ticket-history version as the next step, and use the four points above as the "here's what we'd need from you" ask.

---

## Summary

| # | Topic | State | Demo prep |
|---|-------|-------|-----------|
| 1 | Short dump analysis | ✅ Ready | Low |
| 2 | Code review | ✅ Ready | Low |
| 3 | Across many programs | ✅ Ready | Low |
| 4 | Next to Joule | 🟡 Feasible | Needs prep |
| 5 | Log interpretation | 🟡 Feasible | Needs prep |
| 6 | SAP Notes search | 🟡 Feasible | Needs prep |
| 7 | Other use cases | ✅/🟡 | One closer |
| 8 | Repeat-ticket detection | 🔵 Roadmap | Recurrence as proof |
