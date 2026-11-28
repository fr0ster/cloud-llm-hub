# Large read throughput

Status: goal, 2026-11-27. No design yet; the owner decides when work starts.

## Why

A client agent that analyses and documents large ABAP developments through the
hub spent most of its time waiting for the hub. The measurements come from a
customer deployment on an older hub release (on-prem SAP system, agent MCP
channel). Read speed is now the critical path for this use case.

## Findings

Evidence (anonymised per-call data, the run's time split, the concurrency test and the analysis script):
[2026-11-27-large-read-throughput-evidence/](2026-11-27-large-read-throughput-evidence/README.md).

Call time is explained almost fully by one formula: about 17 s plus 3.3 s per
1 000 characters of the answer, so the hub delivers about 300 characters per
second.

1. **The hub's model retypes the answer: about 4 of 9 hours.**
   - Time grows with answer size: below 2 000 characters the median is 17 s;
     above 40 000 characters it is 194 s.
   - All the slowest calls read source code of large classes (25 000–85 000
     characters, 800–2 700 lines) and took 200–356 s; some failed on the
     client's 300 s timeout.
   - The model seems to rewrite the SAP tool result token by token.
   - The same cause explains "compressed" code (35 answers) and answers
     without the code (21).
2. **Fixed cost per call: about 17 s, 5 hours in total.**
   - Reading one table row takes 7.5 s on an idle hub and 15–19 s during a run.
   - The hub reports its internal steps, but the time barely depends on how
     many steps there are.
3. **Requests of one user run one at a time.**
   - 1, 3, 6 and 10 concurrent requests took 7.5, 22, 51 and 75 s: concurrent
     requests queue.
   - Heavy calls sent at the same time sometimes came back empty.
4. **Misread requests that the client had to repeat: about 1.1 hours.**
   - A destination name in the task text was taken as a user filter.
   - A list of values in a filter returned nothing.
   - A request for a whole tree returned a sample.
   - ENHO source was not returned.
   - Domain values were labelled wrongly.
   - `UNVERIFIED_WRITE` warnings were added to read-only answers.
5. **Outage on 2026-11-26 from 21:03 to 21:44 UTC, degraded from 20:51.**
   To be matched against the server logs of that deployment.

## Goal of this PR

Large reads through the hub cost about what the SAP read itself costs, and the
answer carries the SAP data exactly as the tool returned it.

Directions named by the client, to be analysed, not yet decided:

- A pass-through mode: source code and table rows go from the SAP tool to the
  client without the model rewriting them.
- A fast deterministic path for fully specified table reads (table, fields,
  equality filters), without planning.
- A batch call that runs several reads at once.

Also in scope of the analysis:

- Why one user's concurrent requests queue, and why heavy concurrent calls can
  return empty.
- The misread requests in finding 4, one by one.
- The outage in finding 5.

## Constraints

- No truncation of tool results and no timeouts or budgets in work paths; the
  result form is chosen by result strategies (session RAG and record ids), not
  by cutting.
- The same tool set on every channel.
- Measurements run on the PoC subaccount; first re-measure on the current
  release, since the findings come from an older one.
