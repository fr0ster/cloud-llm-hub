# Scaffold a RAP Managed BO

**Goal:** End-to-end demo — generate a RAP BO with draft, service binding, and a test OData call.
**Destination:** `S4HANA_DEV`.
**Expected tools invoked:** full create/activate tool chain (package → table → CDS → BDEF → BIMP → service).
**Related skill:** see the existing tutorial at [tutorials/skills/rap-bo-creation.md](../../../tutorials/skills/rap-bo-creation.md).

## Prompt

> Follow the RAP BO creation skill to create a managed BO for "Demo Promotion Campaign" in package `Z_DEMO_SALES`:
>
> - Root entity fields: `CampaignID` (UUID, key), `Name` (CHAR80), `StartDate` (DATS), `EndDate` (DATS), `DiscountPct` (DEC 5,2), `Status` (CHAR10).
> - Draft enabled.
> - Determine `CampaignID` on create.
> - Validate `EndDate >= StartDate`.
> - Service binding OData V4, entity set `Campaigns`.
>
> Execute steps in dependency order. After each layer, verify by reading the object back. At the end, return the binding URL and a sample `GET` against it.

## Expected Outcome

- Ordered execution trace (package → tables → CDS → BDEF+BIMP → service).
- Binding URL returned.
- Sample curl/HTTP GET against the binding.

## Troubleshooting

- **Agent tries to activate BDEF alone** — reject; ask it to activate BDEF + BIMP together.
- **Hallucinated creations** — if prompt tokens < 20K per step, treat as fake and redo.
- **Draft table missing** — ask: "Ensure the draft table is generated before activating BDEF."
