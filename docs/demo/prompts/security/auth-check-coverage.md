# Authorization Check Coverage

**Goal:** Verify that sensitive operations are guarded by `AUTHORITY-CHECK` or declarative equivalents.
**Destination:** `S4HANA_DEV`.
**Expected tools invoked:** `GetClass`, `GetProgram`, `SearchObjects`.

## Prompt

> For package `Z_DEMO_SALES`, list every method / form that performs data modification (INSERT, UPDATE, DELETE, MODIFY, CALL TRANSACTION, CALL FUNCTION destination 'NONE') and check whether it is preceded by an `AUTHORITY-CHECK` or relies on a RAP authorization control.
>
> Report:
> - Protected — method name + auth object used.
> - Unprotected — method name + risk (Read/Write/Execute).
> - RAP-controlled — entity + authorization implementation class.
>
> Consider wrapper methods (a method that only calls a protected one is also protected).

## Expected Outcome

- 3 lists: Protected / Unprotected / RAP-controlled.
- Each entry with class/program + method/form name.
- Auth object names (e.g., `S_TCODE`, `V_VBAK_VKO`) where detected.

## Troubleshooting

- **"All protected"** in a real codebase is suspicious — ask the agent to recheck by following callers.
- **No RAP entities found** — skip that section, don't invent.
