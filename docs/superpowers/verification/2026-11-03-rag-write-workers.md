# 10.4.7: Session worker storage and deterministic persistence

Branch: `feat/10.4.7-rag-write-workers`. No commit created.

## Decisions

Dialogue execution carries an AsyncLocalStorage marker. Local tool dispatch passes an explicit worker/coordinator role into execution authorization. Workers can create only session collections and add/update/toggle records only in collections owned by their user and current session. Other mutations are rejected. Reads keep existing visibility. Plain chat, direct user MCP and REST preserve current behavior.

The coordinator exposes four RAG reads plus `rag_persist`; it cannot author records through other RAG mutations. Persistence accepts source collection, optional exact record ids and target collection name. Default selection includes all enabled records, read in bounded pages. Sources must belong to the current user/session, including for admins. Target creation and upsert use normal registry ingress, preserving quotas and sanitizing privileged trust metadata. Text and ordinary attributes are copied verbatim. Added `persistenceProvenance` contains source collection, source record and timestamp. Repeated calls upsert the same record ids; timestamps reflect the latest copy. Multiple source collections targeting the same record id intentionally update that target record.

Worker seeds, runtime capability notes and planner-facing descriptions explain session storage and coordinator persistence even for existing stored profiles. Coordinator seed adds one informational line.

Exact library translation prompts retain `rag-translation`; unknown system prompts retain the caller component. Tests cover both paths.

## Validation

TypeScript application and test checks, Biome changed-file checks and targeted Jest suites are run for this revision. Final results are recorded below. No timeouts added.

## Files

Runtime: `srv/agent-mcp-rag.ts`, `srv/lib/dialogue-rag-tools.ts`, `srv/lib/rag-tool-catalogue.ts`, `srv/lib/rag-write-operations.ts`; existing worker tool policy changes remain in `agent-profile-tools.ts`, `recording-mcp-client.ts`, `tool-authorization.ts`.

Descriptions: `srv/lib/agent-profile-runner.ts`, `srv/lib/agent-profile-source.ts`, `srv/agent-profiles/{_worker-base,analyst,checker,executor,coordinator}.md`.

Capture: `srv/lib/context-capture.ts`. Tests: `test/unit/{dialogue-rag-tools,context-capture,agent-mcp-rag,agent-profile-tools,agent-profile-runner,agent-profile-source,dialogue-planner-agent,openai-channel}.test.ts`. Documentation: `CHANGELOG.md`, `docs/llm-agent/CONFIG_USAGE.md`, this note.

Final results:

- `npx.cmd tsc --noEmit`: passed.
- `npx.cmd tsc --noEmit -p tsconfig.test.json`: passed.
- Biome on all 18 changed TypeScript files: passed, no diagnostics.
- Targeted Jest: 8 suites passed, 307 tests passed (dialogue-rag-tools, context-capture, agent-profile-source, agent-profile-runner, agent-mcp-rag, dialogue-planner-agent, agent-profile-tools, openai-channel).
- `git diff --check`: passed (line-ending notices only).

The shared write resolver keeps existing name-shadowing and cross-session behavior. The global-name regression test now expects the existing fail-closed lookup result instead of assuming global knowledge is resolvable by logical name.
