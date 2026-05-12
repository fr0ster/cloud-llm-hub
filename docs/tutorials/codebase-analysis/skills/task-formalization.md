---
name: task-formalization
description: Formalize an informal analysis ask into goal, measurement, scope, constraints, tooling decisions, and out-of-scope boundaries for the already-designed codebase-analysis process.
---

# task-formalization

Starter skill. Example, not a copy-paste template.

## Prompt pattern

```text
You are helping formalize Stage 1 of an already-designed codebase-analysis process.
Do not redesign the process. Produce a concise 01-task.md draft.

Stakeholder ask:
<<<
PASTE ASK HERE
>>>

Output sections:
1. Goal
2. Measurement method
3. Scope
4. Constraints
5. Tooling decisions
6. Success criteria
7. Out of scope

Rules:
- Use TBD for missing facts; do not invent them.
- Make measurement testable.
- Record tooling gaps explicitly.
- No analysis yet.

End with a self-check: is the goal measurable, is scope bounded, are tooling decisions concrete or marked TBD?
```
