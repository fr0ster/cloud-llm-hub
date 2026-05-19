# RETRO — 2026-05-19 sFTP analysis run

> Internal retrospective. Audience: the team running the next analysis like this.

## TL;DR

A 13-seed stakeholder list became a 19-object migration scope (+46%) via seven independent SearchSource scans plus per-object source verification. Took ~2.5 hours wall-clock and ~1.05 M cloud-side LLM tokens. Methodology held up; lots of refinement happened mid-run and got captured as reusable skills.

## Wall-clock breakdown

| Phase | Wall-clock |
|---|---|
| Briefing, methodology setup, spec drafting | ~30 min |
| Stage 2 batch (13 seeds, first pass Ukrainian — discarded) | ~7 min |
| Stage 2 batch re-run in English (correct prompt) | ~10 min including retries |
| Stage 2b open-ended method enumeration (8 yes seeds) | ~5 min |
| Stage 2c ZMEDI wrapper bodies + BNP snippet | ~5 min |
| Stage 3 SearchSource sweep (3 scans + ZERX FM enum + 2 verify) | ~45 min including the 600s timeouts and overload retries |
| Skill / lesson / spec / issue authoring | continuous, ~20 min total |
| Stage 4 / 5 / session-log / pptx / RETRO | ~15 min |
| **Total** | **≈ 2 hours** |

Reference point: a comparable manual analysis through the cloud-llm-hub UI is estimated at 4–12 hours by the user. Headroom is real but not 10×; the gains come more from (a) parallelizing reads via batch curl scripts and (b) the per-stage methodology not letting the analyst lose the thread.

## Token accounting (cloud-llm-hub side)

Computed from `usage.models.*` across every SSE response in `curl/`.

### Executor side — cloud-llm-hub (SmartAgent + RAG embedder)

| Model | prompt tokens | completion tokens | total | requests |
|---|---|---|---|---|
| `gpt-5.2` | ~993k | ~49k | **1,042,135** | 212 |
| `embedder` | 11,998 | 0 | 11,998 | 52 |
| **GRAND (executor)** | | | **1,054,133** | **264** |

### Controller side — this Claude Code session (Claude Opus 4.7)

Captured at end of the combined sFTP + code-review work, split ~70/30 between the two tutorials by wall-clock estimation (sFTP was the larger / longer task):

| Model | input | output | cache read | cache write | session cost (combined) |
|---|---|---|---|---|---|
| `claude-opus-4-7` | 13.0k | 518.0k | 138.7M | 1.9M | $94.53 |
| `claude-haiku-4-5` | 4.8k | 18 | 0 | 0 | $0.005 |
| **GRAND (combined session)** | | | | | **$94.53** |

Approximate per-tutorial split (70% sFTP / 30% code-review by wall-clock):

- **sFTP controller share:** ~363k output + ~12.5k input + ~97M cache-read ≈ **$66.17**
- code-review controller share: ~156k output + ~5.3k input + ~42M cache-read ≈ $28.36 (see code-review/examples/ZDMS_UPLOAD_FILES/RETRO.md)

Splitting limitation: `/cost` is session-cumulative, not per-task. Future runs should capture `/cost` baseline before each task — see `feedback-token-accounting-both-sides` in memory.

Largest single consumer was Stage 2 (the 13-seed verdict batch — ~400k tokens). Stage 3 SearchSource sweeps were each ~30–50k due to large source-text echoed back from the backend.

Provider note: this subaccount routes any `model` argument to OpenAI `gpt-5.2` regardless of what the client requested. Anthropic models are not available in `ai-applications`. Token cost is OpenAI-side, not Anthropic-side.

## What went well

- **Per-stage isolation.** Doing one focused batch at a time, with the artifact written to disk before the next stage, kept context bounded. When a retry was needed, the prior stage's artifact stayed authoritative.
- **Raw-SSE evidence.** Every claim in `02-methods.md` / `02b-methods-deep.md` / `02c-code-extracts.md` is reproducible from `curl/stage-*/response-*.sse`. No "the agent said X but I lost the transcript" — the transcript is on disk.
- **Lessons captured at the moment they happened.** Six lesson skills + one decision skill + one tool-usage skill were authored *during* the run, while the surprise was fresh. None were rationalized after the fact.
- **Iterative scope expansion.** The +38% jump from seeds to confirmed list came from three independent scans on different markers, each justified by a finding from the previous stage (key-auth, then password-auth, then wrapper-FM substring). Methodology was explicit, not improvised.

## What went wrong (and what we did)

### 1. First Stage-2 batch in Ukrainian → wasted ~500k tokens

I wrote 13-seed prompts in Ukrainian because the user was chatting in Ukrainian. Result: all `02-methods.md` content came back Ukrainian, can't ship to manager.

**Fix:** killed the batch, archived under `_archive_ua_run/` for evidence, re-ran all 13 in English. Saved `feedback_artifacts_english_includes_prompts.md` to memory so next session doesn't repeat.

### 2. SmartAgent prompted with too few SearchSource params → truncated results, lost hits

Stage 3 attempt #1 used only `max_objects: 2000`. Server returned `truncated.by_object_cap: true` after 819 scanned. Then I went to raw MCP as a workaround.

**Fix:** user corrected me — workaround is internal-only, the proper path is to spell out every parameter in the SmartAgent prompt. Verified that explicit params (`max_objects: 5000`, `max_hits_per_object: 10`, `emit_no_hits: false`, `object_types: ["PROG","FUGR","CLAS"]`, `concurrency: 8`) yield the same 9 hits as raw MCP, no truncation. Captured in `using-searchsource.md` and `feedback_workaround_policy.md`.

### 3. AND-query timed out at 600s

`SearchSource` with `query="SXPG_COMMAND_EXECUTE"` + `query2="HOST_KEY"` against `Z001` timed out with no partial result. Filed as `mcp-abap-adt#89`. Worked around by single-keyword scans (`PRIVATE_KEY_PATH`, `FTP_PSWD`, `_FROM_SFTP` substring) — each completes in 7–10 minutes and returns complete results.

### 4. Four parallel SearchSource calls saturated the SAP backend

I fanned out 4 `SearchSource` calls in parallel for wrapper-FM caller discovery. Each had `concurrency: 8`, so 32 parallel scan workers hit one SAP destination. All 4 timed out at exactly 600s.

**Fix:** combined the 4 queries into one substring scan (`_FROM_SFTP`). Returned complete in 443s. Captured in `feedback_dont_overload_sap_backend.md` and as an addendum to issue #89. User feedback: "we can wait, the main thing is not to crash the backend" — stability over wall-clock from now on.

### 5. Model tool-amnesia on mid-session retries

SmartAgent twice claimed `GetIncludesList` / `GetInclude` (or `ReadProgram`) "are not available" after using them earlier in the same session.

**Fix:** explicit positive assertion in the prompt — "You have the tool `<Name>`. It is available. Call it." Recovered both cases. Captured in `lessons/assert-tool-availability-in-prompt.md`. The negative-assertion path ("Do not call X") is worse — it leaks the tool name into context and can itself trigger the failure.

### 5b. Substring scan missed a wrapper because of naming variant

Stage-3 substring scan used `_FROM_SFTP` and claimed wrapper-FM completeness. Then a sanity scan for the SM69-prefix literal `ZSFTP_` surfaced a third wrapper FUGR — `ZDMS_SEND_FILE` — containing `ZDMS_EXTRACT_DOCS_TO_SFTP` (note `_TO_SFTP`, not `_FROM_SFTP`). The original substring scan never had a chance because the team that wrote ZDMS used a different naming convention.

**Fix:** scope expanded from 18 to 19 objects, +38% to +46%. Captured the principle in `lessons/dont-rely-on-naming-for-consumer-discovery.md`: don't rely on names — use the call-site literal scan (SXPG_COMMAND_EXECUTE), the credential-bag literal scan (PRIVATE_KEY_PATH / FTP_PSWD / pname literals like `ZSFTP_`), and `GetWhereUsed` on confirmed artifacts. Name-pattern scans are a sanity step, not the source of truth.

### 5c. ZDMS_SEND_FILE has 0 confirmed callers in Z001

After discovering `ZDMS_EXTRACT_DOCS_TO_SFTP`, a follow-up SearchSource on its name returned only the definition — no callers in Z001. Possibilities: dynamic `CALL FUNCTION lv_fm` (not caught by literal scan), cross-package callers (Y* or other roots), RFC/job invocation from another system, or dead code.

**Outcome:** added to migration scope anyway — the FM is real and does SFTP via SXPG; whatever invokes it must be discovered as part of the cutover.

### 6. SearchObject vs SearchSource confusion

A Stage-2 prompt that mentioned both tools caused the model to call `SearchSource` for the existence check. Two seeds were reported `not-found` by mistake.

**Fix:** never mention both tools in one prompt. Existence checks use `SearchObject` only. Captured in `lessons/searchobject-vs-searchsource.md` and `feedback_no_searchobject_and_searchsource_together.md`.

### 7. Model entered an infinite loop on `GetIncludesList`

One Stage-2b seed (`ZSD_MEDICARE_PDF_PROCESS`) saw the model call `GetIncludesList` 50+ times in a row before timing out. No content produced.

**Fix:** add "exactly ONCE" guards in the prompt for each tool step. Captured in `lessons/agent-tool-loop-needs-once-guard.md`.

### 8. GetProgFullCode discovered late

The user mentioned a tool that reads full code including includes; I missed it in my first probe because my search was too narrow. It turned out to be `GetProgFullCode(name, type)`, and the server exposes 184 tools total.

**Fix:** captured in `abap-read-tool-choice.md` with the caveat that for `type: FUGR` the tool returned metadata-only XML during this run — needs follow-up investigation.

## Net new artifacts produced

Reusable across future analyses:

- `skills/method-discovery.md` (updated) — Stage-2 driver skill with the per-tool sequence baked in.
- `skills/abap-read-tool-choice.md` — when to use which ABAP read tool.
- `skills/using-searchsource.md` — how to drive SearchSource through SmartAgent without truncation or backend overload.
- `skills/lessons/sxpg-command-execute-is-sftp.md`
- `skills/lessons/abap-include-chain-needs-deeper-read.md`
- `skills/lessons/searchobject-vs-searchsource.md`
- `skills/lessons/assert-tool-availability-in-prompt.md`
- `skills/lessons/agent-tool-loop-needs-once-guard.md`
- `skills/lessons/cross-domain-naming-is-normal.md`

Memory entries (kept private, persist across sessions):

- `project_ai_applications_subaccount.md` — provider/destination quirks of this subaccount.
- `feedback_artifacts_english_includes_prompts.md` — prompts to SmartAgent are artifacts.
- `feedback_no_searchobject_and_searchsource_together.md`
- `feedback_workaround_policy.md`
- `feedback_dont_overload_sap_backend.md`

Upstream issue: `fr0ster/mcp-abap-adt#89` with three comments tracking AND-query timeout, parameter clamp / hit loss in SmartAgent, and parallel-scan backend overload.

## Lessons for the next analysis run

1. **Spell out every SearchSource parameter in the prompt.** Don't rely on planning-LLM defaults. See `using-searchsource.md`.
2. **One SearchSource at a time per destination.** If you have N keywords, prefer one substring scan over N parallel exact-match scans.
3. **Never mention `SearchObject` and `SearchSource` in the same prompt.**
4. **Assert tool availability positively, never negatively.**
5. **Add "exactly ONCE" guards to every multi-step tool-use prompt.**
6. **English prompts always. Artifacts are English-only.**
7. **Don't reach for raw MCP as a recipe.** It's a fallback. If the prompt can be fixed, fix the prompt. If it can't, file an issue and use MCP for that step only.
8. **Save lessons as you find them, not after.** Six skill files written during the run, not as a closeout activity.

## Open items for the methodology itself

- **`GetProgFullCode` for FUGR returns metadata only** — investigate or document the gap; current workaround is FM-name SearchSource + `GetFunctionModule`.
- **AND-query SearchSource timeout** — upstream `mcp-abap-adt#89`. Once fixed, the AND-shape becomes the cleanest "filter SFTP-only SXPG callers" approach.
- **`max_objects` clamp / hit loss on SmartAgent** — was actually a prompt issue, but worth verifying with an integration test (per the "preserve hits across response assembly" recommendation in `using-searchsource.md`).

## Methodology validation

The 5-stage tutorial held up. Two refinements emerged that should fold back into `README.md`:

1. **Stage 2b** (open-ended method enumeration after Stage 2 verdict) is necessary because the Stage-2 prompt biases toward whichever rules you state. The unbiased enumeration catches non-obvious mechanism variants (wrapper FMs, alternative SM69 commands).
2. **Stage 3 sweep needs at least two independent markers.** Single-marker scans miss legacy auth variants (the password-only `ZSFTP_BNP_PARIBAS` would have been missed by `PRIVATE_KEY_PATH` alone).

Will propose these in a follow-up PR to the tutorial README.

3. **Late-stage sanity scans are not optional.** The third sanity scan (`ZSFTP_`) caught a wrapper FUGR the first three scans missed. Plan for at least one independent cross-validation marker beyond credential-bag literals.
