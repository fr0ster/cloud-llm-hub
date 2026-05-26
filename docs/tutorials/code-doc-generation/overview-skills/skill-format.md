---
name: abap-overview-format
description: Write ABAP program overview documentation as a markdown file — source prompt, collected artifacts, business purpose, process flow, extensions, operational constraints, deep-dive suggestions
---

# abap-overview-format

Save the result to RAG collection `result` using `rag_add`, with id `<PROGRAM-NAME>-overview`, using exactly these sections in this order.

---

## Source prompt (including this text)

The user's original request — the short message they typed — verbatim, inside a code block.
Do NOT include skill text, RAG context, or system instructions here. Only the user's own words.

---

## Collected artifacts (reports, includes, enhancements, BADIs)

- Report `<NAME>` with core includes: `<list>`.
- Persistent tables touched: `<list>`.
- Extension hooks via BAdIs `<NAME>` (interface `<IF_NAME>`): brief description of each.
- Generated outputs: Smart Forms / IDocs / files / none.

---

## Business purpose and key scenarios

2–4 bullets. Each describes one concrete business operation or user scenario the program supports.

---

## High-level process overview

Numbered list. Each item: **Bold phase name**: one-sentence description of what the program does at this step. Include and approximate line in parentheses.

---

## Extension summary (enhancements, BADIs, switches)

One bullet per extension:
`BADI_NAME` (interface `IF_NAME`): what it does; which methods it exposes; when and how a customer implementation is called.

---

## Prerequisites and operational constraints

Bullet list of what must exist for the program to run:
- Required SM69 commands / customizing entries / file directories.
- Execution context (dialog-only, background-capable, specific auth object needed).
- External systems called (RFC destinations, file shares, APIs).
- Behavior when a required BAdI is not implemented.

---

## Suggested deep-dive topics

One bullet per topic. Name the include or flow and state what is unclear or undocumented there.

---

## Formatting rules

- All object names, include names, BAdI names, table names in backticks.
- Every claim in "Business purpose", "Process overview", "Extension summary", "Constraints" traceable to an include and approximate line.
- No placeholders in the saved artifact.
