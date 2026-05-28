---
name: rag-artifact-ids
description: Save phase outputs under fixed RAG ids — `doc-task` (phase 1, target + neutralised template + constraints), `analysis-plan` (phase 2, the questions + the MCP tools picked per question), `evidence-§N` one per spec section (phase 3, raw findings + citations), `tech-spec` (phase 4, final assembled doc). Use `rag_add` to create, `rag_correct` to update. Never create a second version under a new id; correct in place. After every rag_add/rag_correct, echo the `RAG OP:` confirmation card so the user can audit.
---
