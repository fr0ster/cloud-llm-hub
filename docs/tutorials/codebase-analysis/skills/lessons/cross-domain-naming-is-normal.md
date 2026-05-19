---
name: cross-domain-naming-is-normal
description: A report whose name suggests one domain may legitimately call SM69/FM artifacts named for an unrelated domain — don't treat this as a red flag, expect it from the start
trigger: a confirmed SFTP usage site whose caller and target artifact are named for unrelated business domains (e.g., FI report calling a payroll command)
---

# Lesson — cross-domain naming is normal, not a red flag

## Trigger

You have a confirmed SFTP caller and its SM69 command / FM target, and the two names belong to different business domains. Example from 2026-05-19 run:

- Caller: `ZDEMO_ACC_POST` (FI accounting posting report)
- Target: SM69 command `ZDEMO_FT_CERIDIAN_GET` (Ceridian = payroll provider)

The instinct is to suspect a mistake or hallucination. Resist it.

## Why this is common in real ABAP estates

- Payroll postings *land in* FI accounting documents, so an FI-posting report needing payroll inputs over SFTP is a normal flow.
- Bank statement loaders *post to* FI, so an FI report calling a "bank" SFTP command is normal.
- Healthcare claims *settle through* AR, so a sales-distribution report calling an EDI SFTP command is normal.
- Operations sometimes wires the same SM69 command from multiple reports across domains to consolidate credential management.
- SM69 commands are often renamed during refactors but callers keep their original names — leaving the cross-domain appearance.

## How to apply

- During Stage-2 / Stage-2b verdicts: **do not flag cross-domain naming as suspicious**. Treat the source evidence as authoritative; the name is metadata, not proof of bug.
- In the migration handoff (Stage 5): record the mapping as-is. Optionally annotate the business flow that explains the cross-domain hop — but only if the source proves it.
- In the deliverable narrative: present cross-domain hops as an *interesting* finding rather than an *error*, e.g., "FI posting report `ZDEMO_ACC_POST` ingests payroll via the Ceridian SFTP channel — a normal end-to-end flow exposed by the analysis."

## What is suspicious vs not

| Pattern | Verdict |
|---|---|
| FI report calls payroll-named SM69 command | normal |
| Sales report calls bank-named FM | normal |
| Report calls SM69 command whose **name pattern** doesn't match the SAP customer's nomenclature at all (e.g., `SAP_DEMO_CMD` in a Z-namespace report) | suspicious — verify by reading the SM69 entry if possible |
| Caller's snippet shows `commandname = 'literal_unrelated_name'` rather than reading from `zfi_constants` | confirm by ReadProgram — could be a leftover test stub |
