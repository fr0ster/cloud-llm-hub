# AI-Assisted Tutorial: Documenting Existing ABAP Code

This tutorial teaches you how to produce a technical specification for an existing ABAP
development by **pair programming with AI**. You drive the analysis; AI runs MCP tools and
fills in the document. You verify every claim against the code.

> **Read first:** [AI Pair-Programming Principles](../AI_PAIR_PROGRAMMING_PRINCIPLES.md) —
> the method behind this tutorial. The methodology is the lesson; the spec you produce is
> the side effect.

**The flow is a transformation pipeline.** Each phase takes the previous phase's artifact
and produces the next one:

```
existing ABAP object
   → Phase 1 → doc-task           (target + format + constraints)
   → Phase 2 → analysis-plan      (questions + tool choices per question)
   → Phase 3 → evidence-§1..§9    (raw findings per spec section)
   → Phase 4 → tech-spec          (the assembled document)
```

A different target object yields a different `doc-task`, which yields a different plan and
final spec. The walkthrough below uses `<TARGET>` for the object — substitute your own ABAP object
(an existing PROG / CLAS / FUGR) and the same flow applies.

**System:** SAP S/4HANA (on-premise) via cloud-llm-hub
**Skill:** Upload `skills/code-doc-generation.md` to a RAG collection before starting
**Template:** Upload `templates/tech-spec-structure.md` and `templates/analysis-questions.md`
to the same RAG collection
**Time:** 30 min — 2 hours, depending on object size
**Prerequisites:** cloud-llm-hub chat UI with MCP connection to the SAP system that hosts
the target object; one working RAG collection for this tutorial

### Progress checklist

Tick each box as you go — keeps you oriented across a multi-hour run.

- [ ] Setup: skill + templates loaded, working RAG collection created, target object chosen
- [ ] Phase 1 — Task framing saved as `doc-task`
- [ ] Phase 2 — Analysis plan saved as `analysis-plan`
- [ ] Phase 3 — `evidence-§1`..`evidence-§9` populated with citations
- [ ] Phase 4 — `tech-spec` written, every section has citations, every gap declared
- [ ] Final cross-check: spot-read one citation per section, confirm it's real

### Work rhythm

- Do one phase, or one question within phase 3, at a time.
- After each saved artifact, tick the checklist and pause.
- Start a fresh chat session after each phase, or every ~10 messages within phase 3.
- If the agent loses the thread, ask: *"Show my current phase, current artifact id, and
  which question we're on."*

---

## Before You Start

### What this tutorial is

Pair programming with AI to produce a customer-grade technical spec for an existing ABAP
object. You drive. AI runs `ReadProgram`, `GetTable`, `SearchSource`, etc. and assembles a
document. **It is not a one-click extractor.** You verify every claim against the code,
because AI will quietly invent rows when the source is silent.

### Ground rules

- **You pick the object and the format.** The skill assumes the neutral template in
  `templates/tech-spec-structure.md`. If your team uses a different one, swap it in
  before phase 1.
- **Phases 1–3 produce documents only.** If the agent tries to run a `Create…` /
  `Update…` tool — stop. We are reading, not modifying.
- **3-4 questions per prompt, no more.** Bigger batches in phase 3 cause hallucination.
- **Every claim is a citation.** A row in a table is suspect until you can point to the
  source file and line that prove it. Ask the agent to show its source on demand:
  *"Quote the lines that prove row N."*
- **Customer namespace only in section 7.** Other Z-namespaces and standard SAP belong in
  sections 5/6 or nowhere. The skill enforces this — push back if the agent leaks.

### Things AI does wrong

| Symptom | What it means | Fix |
|---|---|---|
| Table row with no line reference | Fabrication | Ask for the citation; if it can't produce one, drop the row |
| `[SmartAgent: Executing …]` line missing | Hallucinated tool call | Ask the agent to re-run the tool and quote the output |
| Custom objects from a different Z-namespace in section 7 | Skill violation | Quote rule 3 back: same namespace only |
| "Complete spec" delivered in phase 2 | Phase confusion | Say "phases 1-3 are gathering evidence; phase 4 assembles" |
| Same prompt gives different answers | Session too long | Start fresh; saved RAG artifacts carry the state |
| `GetProgFullCode` runs for a 4k-line program | Wrong tool | Switch to `ReadProgram` + targeted `SearchSource` |

### The two artifacts you load before phase 1

1. **`skills/code-doc-generation.md`** — the rules the agent must follow
2. **`templates/tech-spec-structure.md`** — the document shape
3. **`templates/analysis-questions.md`** — the analysis-time questions

Upload all three to the same RAG collection, scope `user`, enabled.

### Choose your target object

Pick **one** existing ABAP development you want to document. PROG, CLAS, FUGR, or a RAP BO
are all fine — but document one thing at a time. Pick something:

- You can read end-to-end (or your team can answer questions about it)
- Small enough to finish in one or two sessions (< ~5k lines of source is comfortable;
  larger objects work too, but expect to chunk phase 3 by include or by class method)
- That has at least one non-trivial flow (selection screen, file I/O, RFC, DB write) —
  pure DDL has nothing interesting to document

---

## Phase 1: Task Framing

**Your role:** business owner of the documented object. **AI's role:** intake analyst.
**Input:** Your target choice + your team's doc requirements (if different from the
neutral template).
**Output:** A short task brief, saved to RAG as `doc-task`.
**Transformation:** informal request ("document X") → structured task with target name,
output format, and any constraints.

### Start the conversation

> Use the `<your-collection>` RAG collection for all artifacts in this tutorial.
> Target: document the ABAP development `<TARGET>`.
> Format: use `tech-spec-structure` from RAG.
> Constraints: customer namespace is `Z*`. Document the report and its includes only —
> do not chase external dependencies into other packages unless they are referenced in
> section 7.

### Let AI summarise the task

> Summarise this task as `doc-task`: target object, format ref, scope, constraints,
> known unknowns at this point.

### Review and iterate

Things to check:

- Target object name is the exact technical name (no typos, no `_F01` suffix when you
  mean the report)
- Output format reference matches the template id loaded in RAG
- Scope statement is explicit about what is **out** of scope (e.g. other Z-namespaces,
  cross-package call graphs)
- Any team-specific format tweaks captured (e.g. "section 2 must be in Ukrainian", or
  "skip section 9, our template doesn't have it")

When the brief is right:

> Save it as `doc-task` in the `<your-collection>` collection.

The agent calls `rag_add`. Confirm via the `RAG OP: rag_add OK` card.

Checkpoint:
- `doc-task` exists in RAG
- You can state the target object, format ref, and scope in one sentence

> Let's plan the analysis.

---

## Phase 2: Analysis Plan

**Your role:** auditor. **AI's role:** analyst.
**Input:** `doc-task` (Phase 1) + `analysis-questions` template from RAG.
**Output:** A plan that lists every question, the MCP tool(s) picked to answer it, and the
expected output shape — saved as `analysis-plan`.
**Transformation:** generic question list → object-specific plan with tool choices.

### Ask for the plan

> Using `analysis-questions` from RAG, produce an analysis plan for the target in
> `doc-task`. For each question:
>   - quote the question
>   - pick the smallest MCP tool that can answer it
>   - describe the expected output shape (table row, paragraph, list)
>   - flag dependencies (question X needs question Y first)
> Save as `analysis-plan`.

### Review the plan

The plan must cover all 10 questions (or your team's variant). Things to verify:

- **Tool choice is minimal.** If the agent picked `GetProgFullCode` for question 3
  (includes list), push it down to `GetIncludesList`.
- **No `AND`-shape `SearchSource`.** Single-keyword scans only — `query` field, no
  `query2`. The skill warns about this but agents try anyway.
- **Order respects dependencies.** Question 7 (custom objects) usually depends on
  question 8 (logic / event blocks) for context. Question 9 (external effects) depends
  on having read the main flow.
- **One artifact per question.** The plan should say where each answer lands —
  `evidence-§1`, `evidence-§2`, etc.

Common fix prompt:

> Question 5 expects a list of standard tables. Don't use `SearchSource` for it — call
> `GetTable` per table name once we know them, after we've read the main flow.

Repeat until the plan is solid. Then:

> Save the plan as `analysis-plan` in the `<your-collection>` collection.

Checkpoint:
- `analysis-plan` saved
- For every question, you can name the tool, the artifact id, and the expected shape
- Dependencies between questions are explicit

> Let's start the analysis.

---

## Phase 3: Code Analysis

**Your role:** verifier. **AI's role:** evidence collector.
**Input:** `doc-task` + `analysis-plan` (from RAG). The object's source code (via MCP
tools).
**Output:** One artifact per spec section: `evidence-§1`, `evidence-§2`, …, `evidence-§9`.
Each artifact contains the raw findings + citations needed to fill that spec section.
**Transformation:** plan + source code → cited findings.

> **The plan keeps changing.** When a question reveals a new sub-question, fix the plan
> first (`rag_correct analysis-plan`), then continue. This keeps the plan and the
> evidence in sync.

### Question by question

Walk the plan in order. For each question:

> Answer question 3 from `analysis-plan`. Save the result into `evidence-§3` via
> `rag_add` (or `rag_correct` if it exists).

After the agent answers:

1. **Check the trace.** Did `[SmartAgent: Executing <Tool>...]` appear in the response?
   If no — the agent answered from memory, not from a tool call. Ask it to redo with the
   tool actually run.
2. **Check the citation.** Each row / paragraph must reference a file path + line range
   or quote source. If a finding has no citation, ask the agent to provide one. If it
   can't, drop the finding.
3. **Check the scope.** Section 7 findings must be in the same customer namespace as the
   target. Push back if a foreign Z-namespace leaks in.

### Detecting fake responses

The same warning signs as the RAP tutorial apply. AI can pretend it called a tool. Watch
for:

- **Low token count** — a real tool call uses 40,000–100,000+ prompt tokens. ~4,000
  prompt tokens means no tool ran.
- **No `[SmartAgent: Executing …]` line** — no trace, no tool.
- **Reply is too fast** — `ReadProgram` on a 4k-line program needs seconds, not instant.

**How to avoid it:**

- Start a fresh session after every 2-3 questions
- After each question, ask the agent to quote one citation back to you verbatim
- If the token count is suspicious, treat the answer as fake and redo

### Iterating on a question

If the answer is partial:

> The answer to question 5 lists 3 tables. The report definitely reads more — I see
> `SELECT … FROM dms_doc_files`. Re-run `SearchSource` for `SELECT` over the program
> and update `evidence-§5`.

If the answer is wrong:

> Row 2 in `evidence-§7` claims package `Z001` for object `Z_OTHER`, but the package
> column is empty in your trace. Drop the row or cite the real package via
> `DescribeByList`.

### Checkpoint between questions

After each question:

> Show me `evidence-§<N>` as it stands. List all citations.

Move to the next question only when:

- Every finding has a citation
- Every citation matches the actual code (spot-check at least one)
- The artifact id matches the plan (no drift like `evidence-section3-v2`)

### When all questions are done

> Confirm every artifact `evidence-§1` through `evidence-§9` exists in the
> `<your-collection>` collection and list them.

Then:

> Let's assemble the final spec.

---

## Phase 4: Documentation Generation

**Your role:** editor. **AI's role:** technical writer.
**Input:** `doc-task` + `tech-spec-structure` + all `evidence-§N` artifacts (from RAG).
**Output:** The final document, saved as `tech-spec` in RAG and as a file under
`<target>/tech-spec.md` in your working folder.
**Transformation:** evidence + template shape → narrative document.

### Ask for the assembly

> Using `tech-spec-structure` for the shape and `evidence-§1`..`evidence-§9` for the
> content, produce the final technical specification for the target named in `doc-task`.
> Save the result as `tech-spec` in RAG and write the file
> `<TARGET>/tech-spec.md`. Cite every claim — line references from the
> evidence artifacts.

### Review the result

Walk the document section by section. For each:

| Check | What to ask |
|---|---|
| Section 1 fields all populated | "Is any field still empty? If so, mark it `[UNKNOWN]`." |
| Section 2 has evidence | "Quote the comment / code line that proves the purpose." |
| Section 3 includes list matches | "Cross-check with `GetIncludesList` output in `evidence-§3`." |
| Section 5 standard tables only | "Are any rows in customer namespace? Move them to 7 if so." |
| Section 7 same namespace only | "Are any foreign Z-namespace objects present? Drop them." |
| Section 8 has line references | "Pick any flow step. Where is it in source?" |
| Section 9 lists real gaps | "Anything in section 9 we could have answered with one more tool call?" |

### Fix what's wrong, then re-save

> Row 4 of section 7 is in namespace Y* — that's outside scope. Remove it. Re-save
> `tech-spec` via `rag_correct`.

### Final cross-check

Before declaring done:

1. Pick three random claims from three different sections
2. Open the cited source line — does it actually say what the spec says?
3. If any of the three fail, the doc isn't done — go back to phase 3 for that section

### Export

The final file lives in `<target>/tech-spec.md`. Commit it as the canonical
record of what this object does, signed by you (the verifier).

---

## What You Learned

After this tutorial you know how to:

1. **Frame** a documentation task crisply enough that the agent doesn't drift
2. **Plan** an evidence-driven analysis with one tool per question
3. **Verify** AI-generated findings against real source — citation by citation
4. **Assemble** a spec that survives an audit because every claim has a line behind it
5. **Spot** fabrication: missing traces, low token counts, foreign-namespace leaks

The key idea: **AI is fast at reading and assembling; it is also fast at fabricating.
The only protection is your citation discipline.** Make every row prove itself.
