# Examples

Projects and scripts that demonstrate how to use cloud-llm-hub as a backend for domain-specific services.

## Architecture

```
[Consumer]  →  [Lightweight Service]  →  [cloud-llm-hub]  →  [SmartAgent + MCP + RAG]
   ↑                  ↓
   └── deterministic JSON response
```

Each example is a standalone project that:
- Accepts domain-specific input (JSON, webhook, etc.)
- Constructs a prompt for cloud-llm-hub
- Calls cloud-llm-hub's API (OpenAI or Anthropic endpoint)
- Parses the LLM response into a structured result
- Returns deterministic JSON to the consumer

## Examples

| Example | Type | Description |
|---------|------|-------------|
| [calm-dump-analyzer](calm-dump-analyzer/) | BTP Service | Receives SAP Cloud ALM ABAP dump alerts, analyzes via cloud-llm-hub, returns structured diagnosis |
