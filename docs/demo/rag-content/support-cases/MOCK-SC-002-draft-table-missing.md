---
type: support-case
tags: [rap, draft, bdef, activation]
system: MOCK-S4H
case_id: MOCK-SC-002
---

# MOCK-SC-002 — RAP BO activation fails with "Draft table not found"

**Reporter:** MOCK-user dev-team-a
**Severity:** Medium
**Status:** Resolved

## Symptom

Activating behavior definition `ZBDEF_MOCK_CAMPAIGN` fails:

```
Draft table ZMOCK_CAMPAIGN_D not found.
Activation cancelled.
```

The persistent table `ZMOCK_CAMPAIGN` exists and is active.

## Diagnosis

The BDEF declares `with draft` but the draft table was never generated. Expected creation order was violated — the developer activated the BDEF before the draft table.

```
Correct order:
1. Persistent table
2. Draft table (generated or created manually)
3. CDS interface view
4. CDS projection view with `@ObjectModel.usageType.sizeCategory: #M`
5. BDEF + BIMP activated together
```

## Resolution

Generate the draft table from the BDEF draft annotation:

1. Open BDEF in ADT.
2. Right-click → "Generate Draft Table".
3. Activate the generated DDIC object.
4. Re-activate BDEF (together with BIMP).

If the agent is driving the creation via MCP, it must:
- Create the draft table explicitly before touching BDEF.
- Verify table existence with `GetTable` before activating BDEF.

## Root Cause Category

Process violation — activation-order constraint not followed.

## See Also
- [tutorials/skills/rap-bo-creation.md](../../../tutorials/skills/rap-bo-creation.md) — canonical order.
- [internal-docs/rap-development-standard.md](../internal-docs/rap-development-standard.md)
