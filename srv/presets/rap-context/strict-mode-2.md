---
name: RAP Strict Mode 2
description: What RAP strict(2) requires of a BDEF — stated as rules, not creation steps
tags: [sap, rap, bdef, strict]
---

# RAP Strict Mode 2

`strict ( 2 )` is the current strict level for RAP BDEFs. It enforces several rules that,
if unmet, fail activation. State these in the spec so the generated BDEF passes the first
check.

## What strict(2) requires

- **Explicit field mapping** in the BDEF — `mapping for <table> { CdsAlias = table_field; }`
  per field. The `corresponding` shortcut produces mapping warnings/errors under strict.
- **All five draft actions** present on a draft-enabled BO: `Edit`, `Activate`,
  `Discard`, `Resume`, `Prepare`. A missing one (often `Discard` or `Prepare`) fails.
- **Lock authorization**: root `lock master`, composed children `lock dependent by <assoc>`.
  (Instance `authorization master` / `authorization dependent by` is separate and optional.)
  See composition-vs-association.
- **Draft table key parity**: draft table keys match the persistent table keys — not
  only `mandt + uuid`.

## Why it matters at spec time

These are not Phase-4 surprises if the spec already states them. The better the Phase-2
spec (explicit mapping, all draft actions, correct auth, key parity), the fewer
activation failures during Phase 4.

## Common mistakes

| Symptom | Means | Fix |
|---------|-------|-----|
| 40+ "mapping for … corresponding" warnings | `corresponding` used | Switch to explicit `{ CdsAlias = table_field; }` |
| Activation fails: missing draft action | One of the 5 actions absent | Add the missing action (often Discard) |
| Draft key error | Draft keys = `mandt + uuid` only | Add the remaining persistent keys to the draft table |
