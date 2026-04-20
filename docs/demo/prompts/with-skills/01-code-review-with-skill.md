# Code Review with abap-code-review skill

## Prompt

> Follow the abap-code-review skill and review class `ZCL_DEMO_PRICE_CALC`. Report findings grouped by severity.

## Why the skill

Default review is vague ("consider OOP"). The skill forces: line-cited findings, severity buckets, concrete fix templates, and rejects generic advice.

## If the agent ignores the skill

> Every finding must cite object name + line number and quote ≤3 lines of actual source. Redo the review.
