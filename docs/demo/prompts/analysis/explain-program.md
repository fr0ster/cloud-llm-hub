# Explain a Program

**Goal:** Turn an unfamiliar ABAP report into a human-readable spec.
**Destination:** `S4HANA_DEV`.
**Expected tools invoked:** `GetProgram`, `GetInclude` (for includes), optional `GetTable` for referenced tables.

## Prompt

> Read program `Z_DEMO_INVOICE_RUN`. Produce:
> 1. One-paragraph business purpose.
> 2. Selection-screen parameters with types and defaults.
> 3. High-level flow as numbered steps (SELECT → transform → OUTPUT).
> 4. External dependencies: tables, function modules, classes.
> 5. Risks you can infer from the code (missing WHERE, SELECT *, hard-coded constants).
>
> Base the answer strictly on the source. If a claim cannot be supported by code, say "unclear from source."

## Expected Outcome

- Structured markdown with 5 sections.
- Risks tied to specific line numbers or keywords.
- "Unclear from source" used instead of guessing.

## Troubleshooting

- **Summary is generic** — agent skipped includes. Ask: "Now open each INCLUDE in this program and refine the flow."
- **No risks listed** — ask explicitly: "Identify ABAP anti-patterns in this code."
