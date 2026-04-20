# Explore a Package

**Goal:** Show how Cloud LLM Hub navigates ABAP package hierarchies without the developer opening SE80/ADT.
**Destination:** `S4HANA_DEV` (or any reachable ABAP destination).
**Expected tools invoked:** `GetPackageStructure`, `GetProgram` (optional drill-down).

## Prompt

> Explore package `Z_DEMO_SALES`. List sub-packages, classes, CDS views, and programs grouped by type. For each top-level class, give a one-line purpose derived from its documentation or first comment block. Flag any object whose name does not start with `Z_` or `ZCL_`.

## Expected Outcome

- Markdown table grouped by object type.
- One-line summaries for classes (pulled from code, not invented).
- Naming violations listed separately.

## Troubleshooting

- **Empty response** — package may not exist or user lacks S_DEVELOP read auth. Try `ZTEST` or a known demo package.
- **Only sub-packages listed** — agent may stop after one hop. Ask: "Now list objects inside sub-package X".
- **Generic summaries** — the agent hallucinated. Follow up: "Re-read `ZCL_FOO` source and correct the description."
