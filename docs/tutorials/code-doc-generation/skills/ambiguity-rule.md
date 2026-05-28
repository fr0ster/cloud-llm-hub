---
name: ambiguity-rule
description: Handle three kinds of ambiguity explicitly, never silently. (1) Object name matches multiple types (e.g. both PROG and FUGR with the same literal name) — list every candidate and ASK the user which to document; never pick. (2) Referenced object does not exist (`SearchObject` returns nothing) — record under "open questions"; never invent contents. (3) A source line has two valid interpretations (e.g. `CALL FUNCTION` with a dynamic name) — state both possibilities and flag for follow-up.
---
