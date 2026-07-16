---
description: Create the draft table for a RAP business object with draft enabled — how its fields are named, which keys it takes, and the draft admin include
name: creating-draft-table
---

# Creating a draft table

The draft table mirrors the persistent table. Same types, **different field names**.

## Field names — the rule that trips people up

Draft fields are named after the **CDS element names**, not the persistent table's
database field names: lowercase, **no underscores**. The CDS view exposes a persistent
field `book_uuid` as the element `BookUuid`, so the draft field is `bookuuid`.

| Persistent field | CDS element | Draft field |
|---|---|---|
| `book_uuid` | `BookUuid` | `bookuuid` |
| `pub_year` | `PubYear` | `pubyear` |
| `currency_code` | `CurrencyCode` | `currencycode` |
| `local_last_changed_at` | `LocalLastChangedAt` | `locallastchangedat` |

(Names above are an illustration from one example object — apply the rule, not the names.
Object names themselves follow the project's own naming policy.)

## Keys

`key client : abap.clnt not null`, then the persistent table's key fields — in CDS
naming. Types stay identical to the persistent table (a `sysuuid_x16` key stays
`sysuuid_x16`).

## Mandatory include

Every draft table ends with the draft administration include:

```abap
"%admin" : include sych_bdl_draft_admin_inc;
```

## Currency and quantity semantics

`@Semantics.amount.currencyCode` must point at the **draft table's own** currency field,
never at the persistent table's:

```abap
@Semantics.amount.currencyCode : 'zdemo01_dbook.currencycode'
price : zdemo01_de_price;
```

## Shape

```abap
@EndUserText.label : 'Draft: <entity>'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table <draft_table> {
  key client         : abap.clnt not null;
  key <key>          : sysuuid_x16 not null;
  <business fields, CDS-element names, same data elements as the persistent table>
  <audit fields, CDS-element names, the SAME data elements as the persistent table>
  "%admin"           : include sych_bdl_draft_admin_inc;
}
```

## Audit fields

The draft **mirrors** the persistent table, so its audit fields carry the **same data
elements** as the persistent table's — do not substitute different ones here. Their types
therefore stay identical (which is what keeps the draft a faithful mirror). The persistent
table is the single place that defines which audit data elements are used; see
`creating-persistent-table`.
