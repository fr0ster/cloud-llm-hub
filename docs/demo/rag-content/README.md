# RAG Content (Mock)

Documents intended to be embedded into the RAG vector store so the agent can ground its answers in "internal" knowledge during demos.

**All data in this folder is fictional.** Identifiers use the `MOCK-` prefix. No real customers, employees, credentials, or incidents.

## Categories

| Folder | Purpose |
|--------|---------|
| [support-cases/](support-cases/) | Support tickets with symptom + diagnosis + resolution. |
| [internal-docs/](internal-docs/) | Naming conventions, development standards, release process. |
| [best-practices/](best-practices/) | Curated ABAP patterns and anti-patterns. |
| [security-kb/](security-kb/) | Vulnerability patterns, code examples, remediations. |

## Indexing

To load into the configured RAG store:

1. Ensure the deployment has `LLM_AGENT_RAG_TYPE=vector` and an embedding model set.
2. Run your usual ingestion path (see `srv/agent-manager.ts` for wiring) pointing at `docs/demo/rag-content/`.
3. Re-deploy or trigger the hot-reload endpoint.

## Authoring Guidelines

- Markdown with clear section headers — embeddings chunk by heading.
- Keep each document focused on ONE topic; split rather than cram.
- Front-matter is optional but recommended:
  ```yaml
  ---
  type: support-case | standard | best-practice | security-kb
  tags: [abap, performance, rap, ...]
  system: MOCK-S4H | all
  ---
  ```
- End each doc with a "See also" section linking adjacent docs — helps retrieval chaining.
