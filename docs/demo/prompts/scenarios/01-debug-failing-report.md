# Debug a Failing Report

## Opening prompt

> Report `ZSALES_OPEN_ORDERS` dumped in PRD last night. Help me root-cause it.

## Facilitator notes

Let the AI drive. Expected trajectory:
1. Ask for dump ID or offer to search ST22 for the most recent dump of that report.
2. Fetch dump and source.
3. Propose hypothesis grounded in code + runtime state.
4. Check recent transports.
5. Propose a minimal fix.

**Nudge only if:**
- AI proposes a fix before reading the dump → "wait, pull the dump first".
- AI invents variable values → "show me the 'Chosen variables' section from the dump".
- AI jumps to refactoring → "minimal diff only".
