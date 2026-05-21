---
name: Avoiding Hallucinated Tool Calls
description: Rules to keep the agent honest — small batches, fresh sessions, evidence-based "active" claims
tags: [agent-discipline, mcp, hallucination]
---

# Avoiding Hallucinated Tool Calls

An agent can fabricate successful tool results without actually calling MCP, especially
under two pressures:

1. **Large batches** — 5+ objects in one prompt. The shape from the first few creations
   gets reused as the pattern for the rest.
2. **Long sessions** — 10+ messages. Earlier successful responses override new tool
   execution; the agent reproduces them verbatim.

## Detection signals

Any one signal is enough to treat the response as fake and redo the step:

- **Prompt token count < ~10 000.** A real tool call burns 40 000–100 000+.
- **No `[SmartAgent: Executing <ToolName>...]` line** in the response.
- **Response arrives in seconds** when six creates should take 30–60 s of tool calls.

## Hard rules

- **Batches of 3–4 objects per prompt, never more.**
- **"Active" is a claim, not a result.** The phrase *"All N objects are active"* is
  meaningless without a real `ReadDomain` / `ReadTable` / `ReadDataElement` call
  returning `active: true`. After every batch create, read each object back —
  preferably in a fresh session.
- **No invented numbering.** Follow the plan / spec list verbatim. No `_V2`, `_NEW`,
  alternate prefixes.
- **No silent additions.** A 21st domain "because it seemed needed" is drift — report
  first, wait for approval.
- **No duplicates.** If `SearchObject` finds a matching name, stop and ask.
- **Start a fresh conversation session after each layer** (or roughly every 10
  messages).

## Common error fix

| Symptom                                           | Cause                                | Fix                                                                  |
|---------------------------------------------------|--------------------------------------|----------------------------------------------------------------------|
| Created list mentions an object that doesn't exist | Hallucinated batch                  | Read each object back; recreate the missing ones individually.       |
| `SearchObject` returns more than created          | Stray creation in another package    | Move/clean up; enforce package per `enforcing-target-package` skill. |
| Same prompt gives different results               | Session too long                     | Start a fresh session; rely on RAG artifacts for state.              |
