---
name: abap-overview-analyze
description: Analyze loaded ABAP source to produce overview documentation — describe what the program does, how it works, what extends it, and what it requires to run
---

# abap-overview-analyze

Run after abap-read-source. Describe the program from the source. Every statement must be grounded in code — not object names, not assumptions.

## Business purpose and key scenarios

What business process this program serves. What concrete operations a user can perform with it (create a document, submit to an external system, print a report, etc.). Inbound vs outbound data flows if applicable.

## High-level process overview

Numbered steps describing the execution path from program start to output. Each step: what the program does, which include handles it, approximate line range. Cover the main path; mention branches only when they serve a distinct business scenario.

## Extension summary

For each BAdI, enhancement spot, or switch-controlled block:
- Where in the execution flow it fires.
- What the interface exposes — method names and what they receive.
- What a customer implementation can do at that point.

## Prerequisites and operational constraints

What the program requires in order to run:
- Runtime configuration that must exist (SM69 commands, customizing tables, file directories, signing tools, etc.).
- Execution context it depends on (dialog session, specific user context, background job, etc.).
- External systems or services it calls (RFC destinations, file shares, provider APIs).
- What happens when a required extension (BAdI) is not implemented.

## Suggested deep-dive topics

Specific parts of the source that were not fully analyzed here and would benefit from a dedicated follow-up session. Name the include or flow and explain what is unclear or undocumented.

## Rules

- Cite include name + approximate line for every non-trivial claim.
- Summarize flows — do not transcribe code.
- Flag ambiguous or inaccessible artifacts as open questions.
- Do not invent API names or business logic not visible in the loaded source.
