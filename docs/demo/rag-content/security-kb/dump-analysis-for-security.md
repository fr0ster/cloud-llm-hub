---
type: security-kb
tags: [security, dump, st22, forensics]
system: all
severity: Medium
---

# Security KB: Analyzing Short Dumps for Security Signals

A short dump is often just a bug — but some categories indicate attempted abuse. Treat these as security incidents, not developer errors.

## High-Signal Dump Categories

### 1. `CX_SY_DYNAMIC_OSQL_SYNTAX`

A dynamic SQL statement failed to parse.

**Bug cause:** developer built a malformed WHERE.
**Attack cause:** user supplied input with unexpected quotes / keywords (`'; DROP TABLE`) and the code didn't sanitize.

**Investigate:** check whether the failing `WHERE (...)` is derived from user input. If yes → SQL injection attempt. Review all requests from the same user in the last hour.

### 2. `CX_SY_AUTHORIZATION_ERROR` from an unexpected code path

A user triggered an AUTHORITY-CHECK failure in a code path normally reached only by authorized users.

**Investigate:** what UI/RFC brought the user here? Indicates probing or URL manipulation.

### 3. `CX_SY_FILE_OPEN` on a path derived from input

Suggests path traversal attempt:
```
/tmp/../../etc/passwd
```

**Investigate:** the full file path that caused the dump. Any `..`, `/etc/`, or Windows `\\` patterns are red flags.

### 4. Memory exhaustion dumps (`TSV_TNEW_PAGE_ALLOC_FAILED`) from a public endpoint

Denial-of-service attempt via oversized requests.

**Investigate:** is the failing report exposed as OData, RFC-enabled FM, or BSP? Rate-limit and add size checks.

### 5. `CX_SY_REGEX` with hostile pattern

ReDoS (Regex Denial of Service) — attacker sent a pattern that causes exponential backtracking.

**Investigate:** source of the regex pattern. Never accept regex patterns from untrusted input.

## Workflow for Security Triage

1. Fetch the dump (`GetDump`).
2. Note exception category (above list).
3. Identify user and client (dump header).
4. Pull recent requests from the same user / source IP — look for clusters of similar dumps.
5. Correlate with SM20 security audit log for the same time window.
6. If pattern matches an attack indicator → escalate to SOC; do not close as "developer bug".

## What a Dump Does NOT Tell You

- Whether the attack succeeded (the dump is by definition a failure).
- Whether the same attacker also sent successful requests you would NOT see in ST22.
- Post-authentication lateral movement — dumps after login look like normal bugs.

Pair dump analysis with SM20 and application logs for a full picture.

## See Also
- [security-kb/sql-injection-dynamic-where.md](sql-injection-dynamic-where.md)
- [security-kb/authorization-bypass.md](authorization-bypass.md)
- [skills/dump-analysis.md](../../skills/dump-analysis.md)
