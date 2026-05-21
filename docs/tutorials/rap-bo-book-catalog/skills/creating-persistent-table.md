---
name: Creating a Persistent Table
description: Rules for creating an ABAP persistent table for a RAP managed BO — UUID keys, audit fields, root-vs-child shape
tags: [sap, ddic, table, rap]
---

# Creating a Persistent Table

A persistent table holds the active records for a RAP entity. One per entity (root or
child). Every field references a data element — never a base ABAP type.

## Root-table shape

| Field                  | Type                            | Role                          |
|------------------------|---------------------------------|-------------------------------|
| `client`               | key `abap.clnt`                 | Mandatory client field        |
| `uuid`                 | key `sysuuid_x16`               | Technical key (managed)       |
| Business key(s)        | key `z##_e_<name>`              | Stable user-visible key       |
| Business fields        | `z##_e_<name>`                  | Domain-typed columns          |
| `created_by`           | `abp_creation_user`             | Audit                         |
| `created_at`           | `abp_creation_tstmpl`           | Audit                         |
| `last_changed_by`      | `abp_locinst_lastchange_user`   | Audit                         |
| `last_changed_at`      | `abp_locinst_lastchange_tstmpl` | Audit                         |
| `local_last_changed_at`| `abp_lastchange_tstmpl`         | ETag base for optimistic lock |

## Child-table shape

Same fields **plus** `root_uuid : sysuuid_x16` linking to the parent root. Keep all the
audit fields.

## Rules

- Every business field references a data element. Base ABAP types (`CHAR`, `STRING`,
  `INT4`) appear inside domains only.
- The data elements (and their domains) must be **active** before the table is created.
- The `LOCAL` software component is required for `TEST_*` / `$*` packages.
- Activate after creation, then `ReadTable` to confirm `active: true`.

## Common error fix

| Error                                  | Cause                                       | Fix                                                |
|----------------------------------------|---------------------------------------------|----------------------------------------------------|
| `Field … is required but not a key`    | Business key missing from the key list      | Re-create with the business key in the key block.  |
| `data element not active`              | Dependency activated out of order           | Activate the data element, then retry.             |
| Create fails on `LOCAL`                | Software component not set                  | Pass `software component LOCAL` explicitly.        |
