# LLM Agent Documentation

SmartAgent configuration, integration, and testing.

**v6.28+:** the SmartAgent now runs as a coordinator-less executor worker under an explicit DAG coordinator (`@mcp-abap-adt/llm-agent` `^20.6.0`), with a result-based reviewer (`NoticeFinalizer`) appending an `UNVERIFIED_WRITE:` notice when a response's claims contradict the actual tool results. See `../architecture/ARCHITECTURE.md` §7 and §16.

## Documents

- [**Config Usage**](CONFIG_USAGE.md) — environment variables and `.mtaext` configuration
- [**Embedded Usage**](EMBEDDED_USAGE.md) — using `@mcp-abap-adt/llm-agent` in cloud-llm-hub
- [**Testing**](TESTING.md) — SmartAgent testing strategy

## Quick Links

- [Back to Documentation Index](../README.md)
