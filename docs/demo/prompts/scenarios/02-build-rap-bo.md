# Build a RAP BO From Scratch

## Opening prompt

> I need a managed RAP BO for "Demo Promotion Campaign" in package `Z_DEMO_SALES`. Start planning.

## Facilitator notes

Let the AI ask clarifying questions. Expected trajectory:
1. AI asks for fields, key type, draft requirement, validations.
2. AI proposes execution order (table → CDS → BDEF/BIMP → service).
3. AI starts creating objects, one layer at a time.
4. After each layer, AI verifies by reading objects back.

**Nudge only if:**
- AI tries to create all objects in one prompt → "do one layer at a time".
- AI activates BDEF without BIMP → "activate BDEF + BIMP together".
- AI invents creations without tool calls → "show me the tool-call trace for the last step".
