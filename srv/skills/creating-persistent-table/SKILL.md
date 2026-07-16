---
name: creating-persistent-table
description: Create the persistent database table for a RAP business object — the source-of-truth table with its UUID technical key, optional human-readable business key, business fields, parent foreign key on a child table, and the mandatory audit fields
---

# Creating a persistent table

The persistent table is the source of truth. It has four field roles; keep them distinct.

## Field roles

1. **Technical key** — `key client : abap.clnt not null` then `key <object>_uuid : sysuuid_x16
   not null`. Every RAP root/child table has a UUID key, always.
2. **Business key** (optional) — a human-readable ID (e.g. `abap.numc(10)`), usually filled via
   early numbering in the behavior definition, not entered by the user. Not part of the
   technical key.
3. **Business fields** — the actual data. Each references a data element (never a domain or
   built-in type directly, so the Fiori label comes along for free).
4. **Audit fields** — mandatory. What the framework actually requires is the **type**, not a
   particular data-element name: the two timestamp roles must be `TIMESTAMPL` and each carries
   the `@Semantics.systemDateTime` annotation that binds its role (`createdAt`,
   `lastChangedAt`, `localInstanceLastChangedAt`) — the role comes from the annotation, not
   from the DE name. Using the **standard `abp_*` data elements is the recommended path**
   (a custom, type-compatible DE also works):
   `created_by : abp_creation_user`, `created_at : abp_creation_tstmpl`,
   `last_changed_by : abp_locinst_lastchange_user`, `last_changed_at : abp_locinst_lastchange_tstmpl`,
   `local_last_changed_at : abp_lastchange_tstmpl`. This is also the single place these audit
   data elements are named — the draft table mirrors exactly these (see `creating-draft-table`).

A child table also carries the parent's UUID as a plain (non-key) foreign-key field, e.g.
`book_uuid : sysuuid_x16 not null` on an Edition table owned by Book.

## Shape

```abap
@EndUserText.label : '<label>'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table <ztable> {
  key client        : abap.clnt not null;
  key <obj>_uuid     : sysuuid_x16 not null;
  <obj>_id           : abap.numc(10);            " business key, optional
  <parent>_uuid      : sysuuid_x16 not null;      " only on a child table
  <business field>   : <data element> not null;   " mandatory fields as needed
  created_by         : abp_creation_user;
  created_at         : abp_creation_tstmpl;
  last_changed_by    : abp_locinst_lastchange_user;
  last_changed_at    : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
}
```

(`<ztable>`/`<obj>` and any concrete field names are an illustration from one sample object —
apply the rule, not the names. The table's own name follows the project's naming policy.)

## Common mistake

| Symptom | Fix |
|---|---|
| Behavior definition activation fails on `etag master`/`lock master` | Missing `local_last_changed_at` or `last_changed_at` audit field |
| Draft table key mismatch later | Persistent table key shape must be UUID + any business keys the draft table will mirror |
