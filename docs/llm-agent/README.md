# LLM Agent Documentation

SmartAgent configuration, integration, and testing.

Chat uses the adaptive coordinator by default (`@mcp-abap-adt/llm-agent-libs`, `^30.5.0`), with executor and checker workers. `LLM_AGENT_CHAT_COORDINATOR=fixed` restores the previous one-step DAG. `NoticeFinalizer` checks completed answers against captured tool results and can append an `UNVERIFIED_WRITE:` notice. The agent MCP `execute_step` runs the executor directly with the same honesty reviewer. See [Architecture](../architecture/ARCHITECTURE.md), sections 7 and 16.

## Documents

- [**Config Usage**](CONFIG_USAGE.md) — environment variables and `.mtaext` configuration
- [**Embedded Usage**](EMBEDDED_USAGE.md) — using `@mcp-abap-adt/llm-agent` in cloud-llm-hub
- [**Testing**](TESTING.md) — SmartAgent testing strategy

## Quick Links

- [Back to Documentation Index](../README.md)
