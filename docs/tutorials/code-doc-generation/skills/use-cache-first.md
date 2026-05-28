---
name: use-cache-first
description: Before calling any MCP tool, check whether the answer is already in `examples/<target>/.cache/` or saved as a RAG artifact. Reuse the cached result; only call MCP again when the cache is missing or explicitly marked stale. Repeated identical tool calls waste tokens and can trigger rate limits or backend caching artifacts.
---
