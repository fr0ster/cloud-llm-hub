---
name: aggregation
description: Stage 6 of code review — merge four per-category findings into a severity-ranked summary
---

# aggregation

Stage-6 skill. Takes `02-security.md` / `03-performance.md` / `04-cleancore.md` / `05-maintainability.md` and produces `06-summary.md` plus the inputs for the manager-facing pptx.

## Goal

A reader of `06-summary.md` sees, in this order:

1. **Severity histogram** — total findings by CRITICAL / HIGH / MEDIUM / LOW / INFO.
2. **Per-category breakdown** — a small matrix showing how findings distribute across categories × severities.
3. **Top findings** — every CRITICAL + HIGH listed in full (location, why, recommendation).
4. **All findings** — a single table indexing every finding by number, severity, category, title, location.
5. **Verdict** — one-line release decision based on severity counts.

## Implementation

No LLM call needed at this stage. The four per-category artifacts already have the structured `### N. <SEVERITY> — <Title>` headings; a Python script does the parsing and aggregation. See the inline Python in the worked example's run (`examples/ZDEMO_REPORT/06-summary.md` was generated this way).

Reference parser sketch:

```python
finding_re = re.compile(r"###\s+(\d+)\.\s+(\*\*)?(CRITICAL|HIGH|MEDIUM|LOW|INFO)(\*\*)?\s*—\s*(.+?)$", re.MULTILINE)
loc_re     = re.compile(r"\*\*Location:\*\*\s*([^\n]+)")
why_re     = re.compile(r"\*\*Why:\*\*\s*([^\n]+)")
rec_re     = re.compile(r"\*\*Recommendation:\*\*\s*([^\n]+)")
# For each per-category file, parse all findings into (severity, category, title, location, why, recommendation).
# Sort by severity (CRITICAL first), then by category.
```

## Verdict logic

```text
if any CRITICAL:
  "Block release. {N} CRITICAL issue(s) found. Fix before any further work on this object."
elif HIGH >= 5:
  "Significant rework needed. {N} HIGH-severity issues — schedule a focused fix sprint."
elif any HIGH:
  "Tactical fixes needed. {N} HIGH-severity issues. Fix this quarter."
else:
  "No high-severity issues. Address MEDIUM/LOW during normal maintenance."
```

Augment with a **CleanCore note** if there are HIGH findings in the cleancore category — this object will not run in S/4HANA Cloud as-is.

## Checkpoint

After writing `06-summary.md`, sanity-check:

- Sum of per-category totals equals total in severity histogram.
- Every CRITICAL/HIGH finding from the per-category files appears in the "Top findings" section.
- The verdict line matches the severity counts.

## Worked example

`examples/ZDEMO_REPORT/06-summary.md` — 30 findings across 4 categories with verdict.

## Related

- `target-formalization.md` — the severity scale this aggregation uses comes from `01-target.md`.
- The four check skills — feed this aggregation.
