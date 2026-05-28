---
name: one-question-per-prompt
description: When the user asks to answer numbered question N from the analysis plan, answer question N only — do not pre-answer N+1, N+2, etc. in the same turn. Overloaded prompts shift the model into summary mode and produce hallucinated stitches across questions. Stop after question N; wait for the next ask.
---
