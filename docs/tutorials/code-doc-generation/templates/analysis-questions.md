# Analysis Questions — what we have to answer from the code

> These questions drive the analysis pass. Each one maps to a spec section (template column
> on the right). Answer them from code only — no business interviews here. Whatever cannot
> be answered from code is recorded as an open question in section 9.

| # | Question                                                        | Spec section | Primary tool(s) |
|---|-----------------------------------------------------------------|--------------|-----------------|
| 1 | What is the object's metadata? (name, type, package, audit)     | 1            | `ReadProgram` / `GetClass` / `GetFunctionGroup` |
| 2 | What is the business purpose, in the words of the code/comments?| 2            | `ReadProgram` (header), `GetDescription` |
| 3 | What include files make up the program?                         | 3            | `GetIncludesList` |
| 4 | What selection-screen fields does the user see?                 | 4            | source scan for `PARAMETERS` / `SELECT-OPTIONS` |
| 5 | Which standard DDIC tables are touched?                         | 5            | `SearchSource` for `SELECT … FROM …` + `GetTable` |
| 6 | Which CDS views are referenced?                                 | 6            | source scan for CDS view names + `GetCds` |
| 7 | Which customer-namespace objects (Z*/Y*/…) are referenced?      | 7            | code scan + `DescribeByList` |
| 8 | What is the runtime flow? Which event blocks, in which order?   | 8            | source read + structural scan |
| 9 | What external effects does the code produce? (DB / FS / RFC)    | 8            | source scan for `UPDATE` / `INSERT` / `OPEN DATASET` / `CALL FUNCTION` / `SUBMIT` |
| 10| What does the code NOT explain by itself?                       | 9            | analysis of gaps |

## Rules

- **Evidence-first.** Each answer carries a line reference or a quoted fragment.
- **One question at a time.** Don't try to answer everything in one prompt — the agent
  fabricates when overloaded.
- **Cache the answers.** Save each answer as a small RAG artifact (or a file under the
  example folder) so the next phase reuses it instead of re-reading the code.
- **Customer namespace.** Section 7 is restricted to the **same** namespace as the object
  being documented. Other Z-namespaces, standard SAP, third-party — out.
