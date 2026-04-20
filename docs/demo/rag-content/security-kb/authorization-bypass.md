---
type: security-kb
tags: [security, authorization, abap, auth-check]
system: all
severity: High
---

# Security KB: Authorization Bypass Patterns

## Pattern 1 — Missing AUTHORITY-CHECK before data modification

### Vulnerable

```abap
METHOD delete_order.
  DELETE FROM vbak WHERE vbeln = iv_order.
ENDMETHOD.
```

### Safe

```abap
METHOD delete_order.
  AUTHORITY-CHECK OBJECT 'V_VBAK_AAT'
    ID 'AUART' FIELD ls_vbak-auart
    ID 'ACTVT' FIELD '06'.            " 06 = delete
  IF sy-subrc <> 0.
    RAISE EXCEPTION TYPE zcx_mock_auth_denied.
  ENDIF.
  DELETE FROM vbak WHERE vbeln = iv_order.
ENDMETHOD.
```

## Pattern 2 — Wrong auth object

Using generic `S_TCODE` to guard a business-data operation is insufficient. S_TCODE only proves the user can enter the transaction — not that they can modify the specific record. Pair S_TCODE with a data-level object (`V_*`, `F_*`, `K_*`).

## Pattern 3 — Auth check on empty result

### Vulnerable

```abap
AUTHORITY-CHECK OBJECT 'V_VBAK_VKO'
  ID 'VKORG' FIELD lv_vkorg            " lv_vkorg is empty
  ID 'ACTVT' FIELD '03'.
```

Empty `FIELD` value grants access if the user has `*` on that dimension. Always resolve the field to a concrete value first; if it cannot be resolved, deny.

## Pattern 4 — RAP BO without authorization control

A managed RAP BO with `authorization master (global)` but empty `get_global_authorizations` implementation grants access to everyone. Every RAP BO with business data MUST implement both global and instance authorization methods.

## Pattern 5 — Dual-purpose helper methods

```abap
METHOD read_order.
  " called by both UI (with auth check) and batch job (without)
  SELECT SINGLE * FROM vbak INTO @DATA(ls) WHERE vbeln = @iv_order.
ENDMETHOD.
```

Helper methods that bypass the UI's auth check become the injection point. Either:
- Require the auth check inside the helper, OR
- Split: `read_order_for_ui` (with check) and `read_order_trusted` (documented as privileged).

## Detection

- ATC rule `CA_MISSING_AUTHORITY_CHECK`.
- Static scan: `DELETE FROM`, `UPDATE`, `MODIFY` outside test code without preceding `AUTHORITY-CHECK` in the same method.
- RAP: BDEF declares `authorization master` but BIMP's `get_global_authorizations` returns no restrictions.

## Remediation Priority

| Finding | Priority |
|---------|----------|
| Missing check on DELETE/UPDATE on core table | Critical — fix immediately |
| Missing check on READ of PII | High |
| Wrong auth object | High |
| Empty FIELD in auth check | Medium |

## See Also
- [security-kb/sql-injection-dynamic-where.md](sql-injection-dynamic-where.md)
- [internal-docs/rap-development-standard.md](../internal-docs/rap-development-standard.md)
