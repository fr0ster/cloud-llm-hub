# doc-task — ZABER_PRESENTATION_FILES

## Target

- **Object:** `ZABER_PRESENTATION_FILES`
- **Type:** PROG (executable report)
- **Package:** `ZABEREZKIN_MENTOR_PR_ACA`
- **Includes:** `ZABER_PRESEN_FILES_TOP`, `ZABER_PRESEN_FILES_SS`, `ZABER_PRESEN_FILES_F01`
- **System / destination:** S/4HANA E19 via `127.0.0.1:3001` with header
  `x-sap-destination: S4HANA_E19` (routed through the `epam-sap-mcp` proxy).

## Output format

Use `tech-spec-structure` from RAG (file:
`docs/tutorials/code-doc-generation/templates/tech-spec-structure.md`). All nine sections
apply — this is a PROG with selection screen, file I/O, custom logic, and external
side-effects, so every section should yield content.

## Scope

- **In:** the main report + its three includes, end to end.
- **In:** any custom-namespace object referenced from those sources (section 7).
- **In:** standard DDIC tables actually touched by the code (section 5).
- **Out:** other reports in `ZABEREZKIN_MENTOR_PR_ACA`. We document this one report.
- **Out:** business interview / user research. Whatever the code does not explain becomes
  an open question in section 9.

## Constraints

- Read the full code first (main + all includes), then resolve dependencies — per the
  user direction: "повний код аналізувати а потім аналізувати залежності".
- Evidence-first. Every claim cites either a metadata field or a source line.
- Customer namespace is `Z*`. Section 7 lists only objects in this namespace.
- The report's intent based on description: "Work with files on the presentation server"
  + functional words from the summary (CSV download/upload, add users, delete files,
  email notification). Verify each statement from source.

## Known unknowns at framing time

- Which authorization checks gate which actions.
- Which standard SAPscript / SmartForm (if any) emits the email body.
- Whether the report writes to any DDIC table or only the presentation server.
- Whether selected file paths or recipient addresses are hard-coded or read from
  configuration.
