# Cloud LLM Hub — Demo Materials

Curated content for demonstrating Cloud LLM Hub capabilities to stakeholders and new teams.

## Structure

- **[prompts/](prompts/)** — Ready-to-use prompts showcasing UI capabilities (discovery, analysis, security, development).
- **[skills/](skills/)** — Reusable LLM skills that standardize how the agent interacts with SAP systems.
- **[rag-content/](rag-content/)** — Mock documents (support cases, internal guidelines, best practices, security KB) intended to be loaded into the RAG vector store to enrich agent responses.

## How to Use

### Prompts
Copy any prompt from `prompts/` into the Cloud LLM Hub chat UI (`/chat/webapp/`). Each file documents expected behavior, required destination, and fallback hints.

### Skills
Skills live as Markdown files. Reference them in system prompts or load via the `LLM_AGENT_SKILLS` mechanism. They encode constraints the model should respect when operating on SAP systems.

### RAG Content
Place the mock documents under `rag-content/` into the RAG vector store configured for the demo tenant. See `srv/agent-manager.ts` for vectorization wiring. For a live demo, pre-index the content before the session.

## Target Audiences

- **Architects / Managers** — start with `prompts/discovery/` and `prompts/analysis/`.
- **ABAP Developers** — `prompts/development/` + `skills/abap-code-review.md`.
- **Security / Auditors** — `prompts/security/` + `rag-content/security-kb/`.

## Conventions

- All content in **English**.
- Mock data is clearly prefixed with `MOCK-` to avoid confusion with real systems.
- No real credentials, customer names, or production identifiers.
