---
type: standard
tags: [abap, naming, standard]
system: all
---

# MOCK Corp — ABAP Naming Conventions

Applies to all custom development in namespace `Z*` across MOCK Corp landscapes.

## Packages

- Pattern: `Z_<BUSINESS_AREA>_<MODULE>` (e.g., `Z_SALES_PRICING`).
- Max 30 characters.
- Each package has a transport layer and a responsible team.

## Global Classes

- Prefix: `ZCL_<AREA>_<PURPOSE>` (e.g., `ZCL_SALES_PRICE_CALCULATOR`).
- Interfaces: `ZIF_<AREA>_<ROLE>`.
- Exception classes: `ZCX_<AREA>_<CONDITION>`.

## CDS Views

| View type | Prefix |
|-----------|--------|
| Interface (R) | `ZI_<AREA>_<ENTITY>` |
| Projection (C) | `ZC_<AREA>_<ENTITY>` |
| Private | `ZP_<AREA>_<ENTITY>` |
| Extension | `ZE_<AREA>_<ENTITY>` |

## RAP Artifacts

| Artifact | Pattern |
|----------|---------|
| Interface CDS | `ZI_<ENTITY>` |
| Projection CDS | `ZC_<ENTITY>` |
| Behavior definition | `ZBDEF_<ENTITY>` |
| Behavior implementation | `ZBP_I_<ENTITY>` |
| Projection behavior | `ZBDEF_C_<ENTITY>` |
| Service definition | `ZSD_<ENTITY>` |
| Service binding | `ZSB_<ENTITY>_O4` (OData V4) |

## Data Elements and Domains

- Data element: `Z_<AREA>_<SEMANTIC>` (e.g., `Z_SALES_DISCOUNT_PCT`).
- Domain: `Z_<AREA>_<SEMANTIC>_D`.

## Programs / Function Groups

- Executable report: `Z<AREA>_<PURPOSE>` (e.g., `ZSALES_OPEN_ORDERS`).
- Function group: `ZFG_<AREA>_<PURPOSE>`.
- Function module: `Z_<AREA>_<VERB>_<NOUN>`.

## Variables

MOCK Corp does NOT require Hungarian notation in new code. Legacy code with `lv_`/`ls_`/`lt_` prefixes MAY keep them for consistency with surrounding code.

## Deviations

Any deviation must be documented in the object's header with justification and reviewer.

## See Also
- [internal-docs/transport-policy.md](transport-policy.md)
- [internal-docs/rap-development-standard.md](rap-development-standard.md)
