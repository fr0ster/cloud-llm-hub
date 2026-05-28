---
name: search-tool-roles
description: SearchObject(name) = repository lookup; returns object type + package or 0 results — the right tool for "does X exist?". SearchSource(query, packages, …) = package-scoped source-text search — the right tool for "where is this code pattern used". Never mention both tools in the same prompt: the model conflates them and picks the wrong one. Existence-check prompts name SearchObject only; source-scan prompts name SearchSource only.
---
