# Dump Analysis with dump-analysis skill

## Prompt

> Follow the dump-analysis skill and analyze short dump `<DUMP_ID>` on CLD/100.

## Why the skill

Default output mixes symptom, hypothesis, and fix into a single paragraph. The skill enforces the 6-step structure (symptom → statement → runtime state → hypothesis → transports → fix) and blocks fabricated variable values.

## If the agent ignores the skill

> Use the exact output template from the skill, including the "Not Determined" section when evidence is missing.
