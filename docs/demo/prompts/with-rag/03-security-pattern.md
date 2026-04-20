# Recognize Known Vulnerability Pattern

## Prompt

> I saw this in our code: `SELECT * FROM vbak WHERE (lv_where).` — is that safe?

## Expected RAG hit

`rag-content/security-kb/sql-injection-dynamic-where.md`.

## Demo value

Agent retrieves the SQL-injection KB, explains the risk with the exact pattern, and proposes the `CL_ABAP_DYN_PRG=>QUOTE` remediation — without needing to read any real source code.
