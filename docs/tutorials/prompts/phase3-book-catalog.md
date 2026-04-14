# Phase 3 Prompts: Book Catalog — Implementation Plan

## Prompt 1: Generate implementation plan

```
Do NOT create any SAP objects yet. We are in the planning phase.

Based on the technical specification, create a numbered step-by-step implementation plan for the Book Catalog RAP application.

Constraints:
- All work is sequential — one object at a time, no parallel execution
- User works interactively with one AI agent (no sub-agents)
- Each step = one prompt from user to agent
- After each step: verify the result before moving to next
- For complex objects (CDS views with circular deps, BDEF): use create-check-fix loop within one step
- Group activation only after all objects in a layer are created and checked
- Prefix: Z##_, package: TEST_##_BOOK

For each step provide:
1. Step number
2. What to create (object name and type)
3. One-line prompt the user would type
4. Expected result
5. Verification command
6. Notes (activation strategy, known issues, dependencies)

Group steps into layers:
- Layer 1: Package
- Layer 2: Domains (one per step)
- Layer 3: Data Elements (one per step)
- Layer 4: Persistent Tables (one per step)
- Layer 5: Draft Tables (one per step)
- Layer 6: Interface CDS Views (create all, then check all, then activate together)
- Layer 7: Projection CDS Views (same pattern)
- Layer 8: Metadata Extensions
- Layer 9: Interface BDEF + BIMP (create-check-fix-activate)
- Layer 10: Projection BDEF
- Layer 11: Service Definition
- Layer 12: Service Binding + Publish

Between each layer: checkpoint — verify all objects active, no inactive objects with our prefix.

Important: keep each step prompt short and self-contained. The user copies it into chat. Reference DDL from the technical specification where needed but don't repeat full DDL in the plan — just say 'use DDL from specification section X'.
```

**Key elements:**
- Sequential execution, no parallelism
- One step = one user prompt
- create-check-fix loop for complex objects
- Layer-based grouping with checkpoints
- Prompts reference spec DDL, don't duplicate

## Results

- 1 iteration, 17K tokens, 46KB file
- 80 numbered steps across 12 layers
- 4 checkpoints between major layers
- Troubleshooting guide included
