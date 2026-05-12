---
name: source-code-search
description: Search source text for one term, record hits with evidence, and merge them into the usage map.
---

# source-code-search

Starter skill. Example, not a copy-paste template.

## Prompt pattern

```text
Run ONE source-text search.

Term: <term>
Scope: <scope>
Channel: <tool/report/manual pasted results>

Output:
- scope applied
- channel
- hits with object, kind, file/include, line, quote
- out-of-scope hits
- truncation/failure status

Rules:
- Every hit needs provenance.
- If output is truncated, record a blind spot.
- Dedup against usage-traversal rows.
- Do not classify purpose.

Self-check: all hits evidenced, channel recorded, truncation handled.
```

ABAP worked-example gap: `mcp-abap-adt` lacks a dedicated source-grep tool; draft `issues/mcp-abap-adt-code-grep.md`.
