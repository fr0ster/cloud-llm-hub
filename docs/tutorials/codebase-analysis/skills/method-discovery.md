---
name: method-discovery
description: For one seed object, decide whether it uses the target mechanism and record the concrete method with evidence.
---

# method-discovery

Starter skill. Example, not a copy-paste template.

## Prompt pattern

```text
Analyze ONE seed object for ONE target mechanism.

Target mechanism: <mechanism>
Seed object: <seed>
Scope: <declared scope>

Use source-reading tools. For ABAP, read the program, then includes.

Return one row:
| Seed | Verdict yes/no/unclear | Method | Evidence | Notes |

Rules:
- One seed only.
- Evidence must be source-backed.
- If source cannot be read, mark a blind spot.
- Do not propose migration.

Self-check: was the source read, is the verdict evidenced, did the row stay inside scope?
```
