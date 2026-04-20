# Generate a CDS View

**Goal:** Show how the agent scaffolds a CDS interface view from a plain-English brief.
**Destination:** `S4HANA_DEV`.
**Expected tools invoked:** `GetTable`, `CreateCdsView`, `ActivateObject`.

## Prompt

> Create a CDS interface view `ZI_DEMO_CUSTOMER_ORDERS` in package `Z_DEMO_SALES` that joins `VBAK` (sales header) with `KNA1` (customer master) on `KUNNR`.
>
> Requirements:
> - Expose fields: VBELN, AUDAT, NETWR, WAERK, KUNNR, NAME1, LAND1.
> - Filter to `AUART = 'TA'` (standard orders).
> - Annotate `@ObjectModel.dataCategory: #TRANSACTIONAL_DATA`.
> - Add `@EndUserText.label: 'Demo Customer Orders'`.
> - Use association to KNA1 (`_Customer`) — do not use classical JOIN unless association is impossible.
>
> Return the source you created, activation status, and any warnings.

## Expected Outcome

- Full CDS source.
- Activation result.
- Warnings (if any) preserved verbatim.

## Troubleshooting

- **Activation fails on authorization** — package may be restricted; switch to `$TMP` for the demo.
- **Fields missing from VBAK** — ABAP system version may differ; ask: "Describe VBAK and adjust the view."
