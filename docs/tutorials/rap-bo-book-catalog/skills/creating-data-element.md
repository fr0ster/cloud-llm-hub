---
name: Creating a Data Element
description: Rules for creating an ABAP data element via MCP — must reference a domain or a predefined ABAP type
tags: [sap, ddic, data-element]
---

# Creating a Data Element

A data element is the named type used in tables and CDS views. It references either a
domain or a predefined ABAP type. It carries the field label seen in Fiori UIs.

## Rules

- Reference a **domain** by name (preferred) or a predefined ABAP type. Never leave the
  type empty.
- **Do NOT use `abap_boolean`.** The MCP handler accepts it but produces a data element
  without a usable type. Use `type CHAR length 1` (or a custom domain with CHAR 1) and
  fill it with `abap_true` / `abap_false` at runtime.
- The domain (if referenced) **must be active first**. If creation fails with
  `domain not active`, activate the domain, then retry.
- Name follows the prefix convention, typically `Z##_E_<NAME>`. Domain/data-element
  pairs share the same `<NAME>` suffix.
- After a batch, run `ReadDataElement` per name to confirm `active: true`. Activate
  explicitly with the prefix filter (`Z##_E_*`) — never run a bare *"Activate all
  inactive"*.

## Common error fix

| Error                                            | Cause                                  | Fix                                                                  |
|--------------------------------------------------|----------------------------------------|----------------------------------------------------------------------|
| `No domain or data type was defined`             | Created with `abap_boolean`            | Re-create as `type CHAR length 1` (or via a CHAR 1 domain).          |
| `domain not active`                              | Consumer created before its domain     | Activate the domain, then re-create the data element.                |
| Created but type is blank                        | Tool call without a type parameter     | Re-create supplying domain name or predefined type.                  |
