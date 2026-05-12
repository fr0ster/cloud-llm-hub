---
name: goal-verification
description: Verify whether the analysis goal was achieved by checking the result against Stage 1 success criteria and naming any return stage.
---

# goal-verification

Starter skill. Example, not a copy-paste template.

## Prompt pattern

```text
Verify the analysis goal.

Inputs:
- 01-task.md success criteria
- 02-methods.md
- 03-usage-map.md
- 04-analysis.md

Produce 05-result.md with:
1. Goal-achievement answer: yes/no
2. Reasoning per success criterion
3. Findings summary
4. Migration handoff input
5. Return decision: done or return to Stage N with reason

Rules:
- Do not design the migration.
- A "yes" must cite evidence from artifacts.
- A "no" must name the stage whose artifact failed.
```
