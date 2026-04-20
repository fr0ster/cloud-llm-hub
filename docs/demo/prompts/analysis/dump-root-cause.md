# Root-Cause an ABAP Short Dump

**Goal:** Show how Cloud LLM Hub correlates a ST22 short dump with source code and recent transport changes.
**Destination:** `S4HANA_DEV`.
**Expected tools invoked:** `GetDump`, `GetProgram`, `GetTransportOfObject`.
**Related skill:** [skills/dump-analysis.md](../../skills/dump-analysis.md).

## Prompt

> Analyze short dump ID `20260415123045DEVELOPER0001` on system CLD client 100.
>
> Deliver:
> 1. **Symptom** — exception class + error message.
> 2. **Failing statement** — program, include, line, ABAP statement.
> 3. **Root cause hypothesis** — what in the code most likely caused it. Quote the lines.
> 4. **Recent changes** — last 3 transports that touched the failing object, with author and date.
> 5. **Suggested fix** — minimal diff, no refactoring.
>
> Do not invent a dump if the ID is not found; report that instead.

## Expected Outcome

- Exact exception (e.g., `CX_SY_CONVERSION_NO_NUMBER`) + source line.
- Hypothesis grounded in quoted code.
- Transport list with real IDs (not fabricated).

## Troubleshooting

- **"Dump not found"** — IDs expire when ST22 is reorganized. Provide a recent ID.
- **No transport info** — object may be local ($TMP) or TMS is not accessible for that user.
