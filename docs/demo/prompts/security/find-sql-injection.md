# Find Potential SQL Injection

**Goal:** Demonstrate static vulnerability scanning through the chat UI.
**Destination:** `S4HANA_DEV`.
**Expected tools invoked:** `SearchObjects`, `GetProgram`, `GetClass`.
**Related RAG:** [rag-content/security-kb/](../../rag-content/security-kb/).

## Prompt

> Scan package `Z_DEMO_SALES` for potential SQL injection. Focus on:
> - Dynamic WHERE clauses built via string concatenation.
> - `EXEC SQL` blocks.
> - `SELECT ... WHERE (lv_cond)` where `lv_cond` comes from user input or RFC parameters.
>
> For each finding return: object name, line, vulnerable snippet (3 lines context), severity (High/Medium/Low) with reasoning, suggested fix using CL_ABAP_DYN_PRG or parameter binding.
>
> Do not report false positives from SELECTs using static WHERE clauses.

## Expected Outcome

- Findings table with exact line numbers.
- Code snippets quoted verbatim from SAP.
- Fix suggestion references `CL_ABAP_DYN_PRG=>QUOTE` or similar sanitizer.
- Empty result is acceptable if package is clean.

## Troubleshooting

- **Too many false positives** — re-prompt: "Filter out SELECTs whose WHERE operand is a constant or a typed parameter of domain DOM_X."
- **Only surface-level findings** — ask: "Now trace callers of these methods to confirm the input is untrusted."
