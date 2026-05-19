---
name: assert-tool-availability-in-prompt
description: SmartAgent sometimes claims a tool is unavailable mid-session — fix is a positive assertion in the prompt ("You have the tool X. It is available.")
trigger: response says "no such tool", "tool not exposed", "cannot do this with available tools" for a tool that demonstrably exists
---

# Lesson — assert tool availability when the model claims it's missing

## Trigger

SmartAgent replies with something like:

> "Impossible with the available tools: there is no `ReadProgram` tool/endpoint exposed here…"
>
> "I cannot complete this because `GetIncludesList` and `GetInclude` are not available in the provided toolset…"

…for a tool that was clearly available earlier in the same session (and that a separate probe confirms exists). The model lost track of it.

## Why this happens

The tool list in the SmartAgent context is regenerated per call from RAG / runtime injection, not from a static system prompt. Under certain conditions (long context, certain prompt phrasing, particular tool combos) the model gets a curated subset and reads its own subset as "the full list". When asked to call a tool not in that subset, it answers "tool not available" — even though the orchestration layer would still happily route the call.

## The fix

Add a one-line positive assertion to the prompt:

> "You have the tool `<ToolName>`. It is available. Call `<ToolName>(...)`."

That is enough to unblock the tool selection. Confirmed twice in the 2026-05-19 run:

- `ZDEMO_EDI_IN` (Stage 2 retry): model claimed `GetIncludesList` / `GetInclude` unavailable. Adding "The tools ARE available; do not skip the call." recovered them — fired ReadProgram + GetIncludesList + 4 GetInclude calls cleanly.
- `ZDEMO_FILE_TRANSFER` (Stage 2c snippet pull): model said "no `ReadProgram` tool exposed here". Adding "You have the tool `ReadProgram`. It is available. Call ReadProgram with name=…" returned the full source on the next try.

## How to apply

- When writing prompts that drive a specific tool chain, prefix each step with a positive availability statement for that step's tool. Cheap, never harmful, robust against the mid-session amnesia.
- When a response says "tool X is not available" — do not change the procedure, just re-issue the same prompt with "You have tool X. It is available." added near the call site.
- Avoid negative assertions ("Do not call X", "Tool Y is not available") — they leak the wrong tool's name into context and can themselves trigger the failure mode. Stay positive: say what to call, not what to avoid.

## Related

- `lessons/agent-tool-loop-needs-once-guard.md` — once you fix the availability claim, you may hit the loop bug.
- `abap-read-tool-choice.md` — names each tool exactly once with its decision rationale.
