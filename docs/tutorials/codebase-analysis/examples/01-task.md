# 01-task - SFTP usage analysis

> Example artifact, not a template. Identifiers are anonymized.

## Goal

Analyze how the ABAP codebase uses SFTP so a future migration tutorial can start from evidence, not guesses.

## Measurement method

The goal is met when `05-result.md` can answer yes to every success criterion below with evidence from stages 2-4.

## Scope

- In: customer namespace `Z*` in `<system>`.
- In: initial stakeholder seed list, anonymized as `Z_VENDOR_*`.
- In: in-scope objects found by where-used or source-text search from discovered SFTP methods.
- Out: SAP standard namespace, other systems, replacement design.

## Tooling decisions

- Object lookup: `SearchObject`.
- Source read: `ReadProgram`, `GetIncludesList`, `GetInclude`.
- Dependency lookup: `GetWhereUsed`.
- Source-text search: `<standard-abap-source-search-report>`; if unresolved, Stage 3 records the tooling gap.

## Success criteria

- Stage 2 identifies SFTP methods for every seed object or records a blind spot.
- Stage 3 maps usage sites through dependency lookup and source-text search.
- Stage 4 interprets each usage site with evidence.
- Stage 5 states whether the goal was achieved and provides migration-handoff input.

## Out of scope

- Designing or building an SFTP replacement.
- Selecting target SFTP APIs.
- Traversing adjacent mechanisms unless they directly explain an SFTP usage site.
