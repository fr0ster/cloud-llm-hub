---
name: Creating a Draft Table
description: Rules for creating an ABAP draft table that backs a RAP draft-enabled entity — CamelCase fields, no draftuuid key, include for admin fields
tags: [sap, ddic, draft, rap]
---

# Creating a Draft Table

A draft table mirrors a persistent table but stores in-progress edits. Its fields and
keys follow a different naming and structural contract than the persistent shape.

## Hard rules

1. **Key fields match the persistent table — minus `draftuuid`.** The draft UUID is
   managed by the `sych_bdl_draft_admin_inc` include. Adding `key draftuuid` causes BDEF
   activation error: *"cannot have a key field DRAFTUUID"*.
2. **Field names are CDS view aliases (lowercased PascalCase, no underscores).** Draft
   storage uses alias values, not persistent-table column names. Examples:
   `authorname` (not `author_name`), `publicationyear` (not `publication_year`),
   `createdby` (not `created_by`). Wrong shape → BDEF error: *"Missing fields
   (CamelCase expected)"*.
3. **`mandt` (not `abap.clnt`)** for the client key.
4. **`include sych_bdl_draft_admin_inc;`** as a line in the DDL — no quoted form, no
   `%_DIFFINCL`. Prefer group name `"%admin"` to avoid warnings.
5. **No `parentuuid` field in child draft tables.** The framework manages parent-child
   linkage via the include. Adding it warns: *"does not expect the field PARENTUUID"*.
6. **Reserved ABAP keywords cannot be field names.** Rename (e.g. `format` →
   `editionformat`) — otherwise *"Statements could not be generated"*.

## Shape

```ddl
@AbapCatalog.tableCategory : #TRANSPARENT
define table z##_<name>_d {
  key mandt          : mandt;
  key uuid           : sysuuid_x16;
  key <businesskey>  : z##_e_<businesskey>;
  <camelcase fields>;
  createdby          : abp_creation_user;
  createdat          : abp_creation_tstmpl;
  ...
  include sych_bdl_draft_admin_inc;
}
```

## Common error fix

| Error                                | Cause                                   | Fix                                                                |
|--------------------------------------|-----------------------------------------|--------------------------------------------------------------------|
| `cannot have a key field DRAFTUUID`  | `draftuuid` declared as key             | Remove it — framework manages via include.                         |
| `Missing fields (CamelCase expected)`| Snake-case field names                  | Rename to CDS alias form: `authorname`, `publicationyear`.         |
| `does not expect the field PARENTUUID`| `parentuuid` in a child draft table   | Remove it — framework wires parent linkage via include.            |
| `Statements could not be generated`  | Reserved ABAP keyword used as field name| Rename (e.g. `format` → `editionformat`).                          |
| `field %_DIFFINCL invalid`           | Wrong include syntax                    | Use bare `include sych_bdl_draft_admin_inc;` (no quotes).          |
