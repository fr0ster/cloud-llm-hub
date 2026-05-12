---
name: usage-traversal
description: Traverse dependency or where-used results for one discovered method and record in-scope usage sites with boundaries.
---

# usage-traversal

Starter skill. Example, not a copy-paste template.

## Prompt pattern

```text
Walk usage/dependency edges for ONE method.

Method: <method>
Scope: <scope>
Lookup tool: <tool>

Procedure:
1. Run lookup on the method.
2. Record in-scope callers.
3. Recurse into wrappers that delegate to the method.
4. List out-of-scope callers in a boundary section.

Output: usage tree + boundary + failures.

Rules:
- Do not infer purpose; Stage 4 does that.
- No caller without lookup evidence.
- No silent drops.

Self-check: every returned caller accounted for, wrappers recursed or justified, failures recorded.
```
