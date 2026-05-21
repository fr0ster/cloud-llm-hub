# analysis-plan — ZABER_PRESENTATION_FILES

Plan follows the user-stated order: **read full code first, then resolve dependencies.**

## Tool choices per question

| # | Question | Spec § | Tool(s) | Artifact |
|---|----------|--------|---------|----------|
| 1 | Object metadata (name, type, package, audit) | 1 | `ReadProgram(ZABER_PRESENTATION_FILES)` (header), `GetIncludesList` | `evidence-§1.md` |
| 2 | Business purpose | 2 | header comments + class/FORM bodies via include reads | `evidence-§2.md` |
| 3 | Program includes | 3 | `GetIncludesList` (already in Q1) | `evidence-§3.md` |
| 4 | Selection screens | 4 | `GetInclude(ZABER_PRESEN_FILES_SS)` | `evidence-§4.md` |
| 5 | Standard DDIC tables | 5 | grep full source for `SELECT … FROM`, then `GetTable` per non-Z hit | `evidence-§5.md` |
| 6 | CDS views | 6 | grep full source for CDS view names; `GetCds` per hit (likely none for a presentation-layer report) | `evidence-§6.md` |
| 7 | Custom-namespace objects | 7 | grep full source for `Z*`, then `DescribeByList` on the unique set | `evidence-§7.md` |
| 8 | Runtime flow | 8 | reading the full source already done — derive ordered narrative | `evidence-§8.md` |
| 9 | External effects | 8 (appendix) | grep full source for: `CALL FUNCTION` (esp. GUI_*, SO_NEW_DOCUMENT_*, EMAIL), `OPEN DATASET`, `WS_DOWNLOAD/UPLOAD`, `AUTHORITY-CHECK`, `MESSAGE` | `evidence-§9-effects.md` |
| 10 | Gaps the code cannot explain | 9 | derived after all of the above | `evidence-§9.md` |

## Execution order — three batches

1. **Batch 1 — Full source read.** Parallel calls:
   - `ReadProgram(ZABER_PRESENTATION_FILES)`
   - `GetIncludesList(ZABER_PRESENTATION_FILES)`
   - `GetInclude(ZABER_PRESEN_FILES_TOP)`
   - `GetInclude(ZABER_PRESEN_FILES_SS)`
   - `GetInclude(ZABER_PRESEN_FILES_F01)`

   Output is the verbatim source of every line that makes up the program. This produces
   the raw input for questions 1, 2, 3, 4, 8, 9 directly, and is the substrate for
   questions 5, 6, 7.

2. **Batch 2 — Identifier extraction.** From the source dump, build the unique set of
   referenced identifiers:
   - DDIC tables (`SELECT … FROM <T>`)
   - CDS views (names starting with `Z..._C_…` / `Z..._I_…` or `Z..._R_…`)
   - Custom objects (function modules, classes, structures, data elements, domains
     starting with `Z` and not local — i.e. not declared in TOP)

3. **Batch 3 — Metadata resolution.** One call per unique identifier set:
   - `GetTable` per standard table → fills §5
   - `GetCds` per CDS view (skip if none) → fills §6
   - `DescribeByList` over the custom-object set → fills §7

## Dependencies

- Q5, Q6, Q7 depend on Batch 1 (must have source first).
- Q9 ("external effects") depends on Batch 1 (source) for the call-site grep.
- Q10 depends on all of the above.

## Constraints

- No `SearchSource` AND-shape queries.
- Reuse cached source from Batch 1 — do NOT re-call `ReadProgram` for follow-up Qs.
- `DescribeByList` once over the deduped set, not `DescribeObject` per item.
