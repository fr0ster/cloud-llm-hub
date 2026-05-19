---
name: method-discovery
description: For one seed object, decide whether it uses the target mechanism and record the concrete method with evidence.
---

# method-discovery

Starter skill. Examples below are anchored to ABAP/SFTP from the worked example, but the shape generalizes to any "does object X use mechanism Y" question.

## Prompt pattern (general)

```text
Analyze ONE seed object for ONE target mechanism.

Target mechanism: <mechanism>
Seed object: <seed>
Scope: <declared scope>

Use source-reading tools. Read the entire object: main source plus every include / inner module / nested artifact. Do not infer from names alone.

Return one row:
| Seed | Verdict yes/no/unclear/not-found | Method | Evidence | Notes |

Rules:
- One seed only.
- Evidence must be source-backed (file:line + snippet).
- A name (PERFORM, method, file) is NOT evidence — only an implementation that calls the target mechanism is.
- If source cannot be read, mark the specific artifact as a blind spot and emit unclear.
- Do not propose migration.

Self-check: was every artifact read, is the verdict evidenced, did the row stay inside scope?
```

## ABAP read procedure (concrete tool sequence)

For ABAP seeds against the cloud-llm-hub MCP tool layer, use this exact sequence. It captures the lessons from the 2026-05-19 run (see `lessons/` for the failure modes that motivated each rule).

1. **Existence check** — call `SearchObject(<seed>)`. Returns type and package, or empty.
   - If empty: verdict is `not-found`, show literal tool output, stop.
   - **Do not call `SearchSource` for this step.** `SearchSource` is a package-scoped text search, not an existence check. See `lessons/searchobject-vs-searchsource.md`.

2. **Main source** — branch by type:
   - PROG → `ReadProgram(<seed>)`
   - CLAS → `ReadClass(<seed>)`
   - FUGR → `ReadFunctionGroup(<seed>)`

3. **Include expansion (PROG only)** — call `GetIncludesList(<seed>)`. The tool returns only NAMES of includes, not their source. Then for **each** include name, call `GetInclude(<include_name>)`. Read every include before forming a verdict.
   - If `GetInclude(X)` returns null, name `X` in the verdict notes and emit `unclear`. See `lessons/abap-include-chain-needs-deeper-read.md`.

4. **Verdict** — based solely on the main source plus its includes. Do not run package-wide search in this stage; cross-package wrapper hunt is `usage-traversal` / `source-code-search` territory (Stage 3).

### Prompt hygiene

- **Do not mention `SearchObject` and `SearchSource` in the same prompt.** The model conflates them and picks the wrong one. See `feedback-no-searchobject-and-searchsource-together` in memory. Stage 2 prompts name `SearchObject` only; Stage 3 prompts name `SearchSource` only.
- Tell the model that `GetIncludesList` and `GetInclude` ARE available. The model sometimes hallucinates their absence after a few iterations. Reinforce in the prompt.
- Write prompts in the artifact-target language (English for manager-facing runs). The model mirrors the prompt language into the response.

### Mechanism-specific evidence rules (ABAP/SFTP example)

Replace these with your own per-mechanism rules in a real run.

- `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` whose `additional_parameters` are assembled from `FTP_USER` / `FTP_DOMAIN` / `FTP_HOST` / `HOST_KEY` / `PRIVATE_KEY_PATH` / `PASSPHRASE` / `SSH_*` = **yes** (legacy OS-shell SFTP via SM69). Record the SM69 command name as the method. See `lessons/sxpg-command-execute-is-sftp.md`.
- A `PERFORM f_*_sftp` whose body you have NOT read = NOT evidence. Read the include where the form is defined.
- `OPEN DATASET`, `GUI_UPLOAD`, `GUI_DOWNLOAD` alone = `no` (local file I/O, not SFTP) unless paired with an SFTP-credentialed SXPG call.

## Concrete prompt template (ABAP/SFTP)

```text
Analyze ABAP object `<SEED>` for SFTP usage.

Procedure:
1. Call `SearchObject('<SEED>')`. If 0 results, verdict is `not-found`, stop.
2. Read main source by type returned in step 1:
   - PROG → `ReadProgram`
   - CLAS → `ReadClass`
   - FUGR → `ReadFunctionGroup`
3. If PROG: call `GetIncludesList('<SEED>')`. For EACH include returned, call `GetInclude(<include_name>)`. Read every include. The tools ARE available; do not skip the call.

Output:
**Verdict:** yes / no / unclear / not-found
**Type:** PROG / CLAS / FUGR / FUNC / ...
**SFTP methods / mechanisms:** ...
**Evidence (program_or_include:line — snippet):** ...
**Notes:** direction (push/pull), endpoint/host hints, payload role — only when source proves it.

Rules:
- SXPG_COMMAND_EXECUTE + FTP_*/SSH_*/HOST_KEY/PRIVATE_KEY_PATH/PASSPHRASE = yes (record the SM69 command name).
- PERFORM name without read body = not evidence.
- OPEN DATASET / GUI_UPLOAD / GUI_DOWNLOAD alone = no.
- `unclear` only when a specific GetInclude returned null; name that include.
```
