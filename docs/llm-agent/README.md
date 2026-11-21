# LLM Agent Documentation

SmartAgent configuration, integration, and testing.

Chat uses the adaptive coordinator by default. `LLM_AGENT_CHAT_COORDINATOR=fixed` selects a one-step DAG. Long-session dialogue uses a coordinator and a stateless plan author. The coordinator decides when to delegate a check, using [actions] journal facts and task notices to cite evidence. Agent MCP exposes orchestration to external coordinators. `execute_step` accepts a worker profile and defaults to `executor`. See [Architecture](../architecture/ARCHITECTURE.md#coordinator-verification-and-the-tool-journal).

## Documents

- [**Config Usage**](CONFIG_USAGE.md) — environment variables and `.mtaext` configuration
- [**Embedded Usage**](EMBEDDED_USAGE.md) — using `@mcp-abap-adt/llm-agent` in cloud-llm-hub
- [**Testing**](TESTING.md) — SmartAgent testing strategy

## Quick Links

- [Back to Documentation Index](../README.md)
