---
name: RAP BO Phase Procedure
description: The 1-to-4 phase flow for building a RAP BO with AI, and the hard phase-guard rule that phases 1-3 produce documents only
tags: [sap, rap, procedure, phase-guard]
---

# RAP BO Phase Procedure

Building a RAP BO with AI is a four-phase pipeline. Each phase consumes the previous
phase's artifact and produces the next.

| Phase | Role of you / AI | Produces | Saved to RAG as |
|-------|------------------|----------|-----------------|
| 1 | domain expert / business analyst | business-requirements **document** | `business-requirements` |
| 2 | architect / technical writer | technical-specification **document** | `tech-spec` |
| 3 | project manager / lead developer | implementation-plan **document** | `impl-plan` |
| 4 | reviewer / developer | **active SAP objects** | — (objects on the system) |

## Phase-guard — the one hard rule

**Phases 1-3 produce TEXT documents only.** Do NOT call any system-changing tool
(`Create…`, `Update…`, `Activate…`) while you are describing or specifying. If you feel
the urge to start generating objects during phase 1-3, STOP — produce the document and
hand it back for approval. System-changing tool calls belong to Phase 4 only.

If the user describes an app and asks for a description/specification, your output is a
**document**, not objects. Generating objects at this point is the "phase confusion" bug.

## Phase transitions

- Move to the next phase only after the current artifact is saved to RAG (`rag_add`)
  and the user has approved it.
- In Phase 4, prompts point to plan steps; you read object names and DDL from
  `impl-plan` / `tech-spec` in RAG — you do not retype them.

## Common mistakes

| Symptom | Means | Fix |
|---------|-------|-----|
| Ran `Create…` while writing the spec | Phase confusion | "Document only, not system" — revert, regenerate the document |
| Started building after the user only described the app | Skipped Phase 1 | Produce business-requirements first; build nothing yet |
| Different result on the same prompt | Session too long | Start a fresh session; artifacts in RAG are intact |
