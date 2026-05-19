---
name: agent-tool-loop-needs-once-guard
description: SmartAgent can get stuck calling the same tool dozens of times — add explicit "exactly ONCE" guards in the prompt
trigger: response SSE shows a tool name repeated 10+ times in a row with no content emitted
---

# Lesson — guard against tool-call loops in prompts

## Trigger

A streamed Stage-2/2b response contains a long unbroken sequence like:

```
[SmartAgent: Executing GetIncludesList...]
[SmartAgent: Executing GetIncludesList...]
[SmartAgent: Executing GetIncludesList...]
... (30+ repetitions) ...
```

with no markdown content between markers. The response ends without a verdict or summary. Wall-clock burns but the response file is small (no content was produced).

## Why this happens

The model decides it has not yet seen "enough" output from a tool, re-invokes it with identical or near-identical arguments, gets the same return, and re-invokes again. There is no built-in step-budget. Without explicit guidance, the model can stay in this loop until the response timeout hits.

Observed in the 2026-05-19 run on `ZDEMO_PDF_PROCESS`: 50+ `GetIncludesList` calls with no `GetInclude` ever firing.

## How to apply in prompts

Add explicit per-step "exactly ONCE" / "do not re-call" guards to any prompt that drives more than one tool call:

```text
Procedure (do each step exactly ONCE):
1. ReadProgram(<seed>) — main source.
2. GetIncludesList(<seed>) — call this exactly ONCE.
   If it returns a list, proceed to step 3.
   If it returns empty/null, skip step 3 and go to output.
3. For EACH include name returned in step 2 (and only those), call GetInclude(<include_name>) exactly ONCE.
   Do not re-call GetIncludesList. Do not call any tool more than once with the same arguments.
4. Stop tool calling once steps 1-3 are done. Do not loop.
```

The phrase "do not call any tool more than once with the same arguments" is the key bit. Without it, the model can rationalize a re-call as "checking" or "retrying".

## Detection

Mechanical check after a batch run:

```bash
grep -oE '\[SmartAgent: Executing [^.\]]+\.\.\.\]' response-NN.sse | sort | uniq -c | sort -rn | head -3
```

If any single tool count exceeds ~5-10 for a Stage-2/2b call (which should never need that many of one tool), suspect this failure. Retry with the guard.

## Related

- `abap-read-tool-choice.md` — names each ABAP read tool exactly once in its decision flow.
- `method-discovery.md` — the Stage-2 driver skill where guards belong.
