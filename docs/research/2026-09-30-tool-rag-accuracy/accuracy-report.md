# Tool-retrieval accuracy: embedders and backends

## TL;DR

- **OpenAI text-embedding-3-large is the most accurate.** At K10 it gets required-recall 0.91 (the share of queries where every step's tool is returned). At K15 it gets 0.97.
- **bge-m3, OpenAI 3-small and AI Core 3-small are about equal.** Required-recall is 0.77 / 0.82 / 0.84–0.85 at K5 / K10 / K15. AI Core 3-small gives exactly the same results as OpenAI 3-small (same model), but it is about 3x slower.
- **The in-memory keyword backend is not usable for Ukrainian queries.** On the non-ASCII subset its required-recall is 0.15 at K5 and 0.31 at K15.
- **Absolute score thresholds are language-biased. Do not use them.** Ukrainian queries score lower across the board. From the t50 cut up, every embedder drops to hit = 0 on the non-ASCII subset.
- **The common failures come from the corpus and the query wording, not from `$TMP`.** Object names that contain `_TEST` pull in the whole unit-test tool family. The probe below shows this.
- **Recommendation:** use K10 for text-embedding-3-large (~16.6 tools on average, ~4.3k prompt tokens) and K10 for the others (same size). If the context budget is tight, K5 costs ~8.3 tools (~2.2k tokens) and loses about 6–9 points of required-recall.

## Setup

- Corpus: `srv/tool-intents.json`, 234 tools. Reader collection = readonly/search/system. Writer collection = `high`.
- 45 queries (31 single-step + 14 multi-step; 16 Ukrainian), each run for 2 role tiers, giving 90 rows.
  - A row is **structural** when some required group has no tool the role can see (for example a Reader asking to create something). There are 22 structural rows. They are counted apart and left out of every quality metric.
- Every cut is its own production `store.query`:
  - K5 / K10 / K15: the store caps **each** collection at k and concatenates them. So the average number of tools returned is 5/10/15 for a Reader and 10/20/30 for a Developer. At ~260 tokens per tool, K5 costs a Developer about 2.6k tokens and K15 about 7.8k.
  - Thresholds: the K15 result, keeping only rows with score >= t. The three t values are the 25th/50th/75th percentiles of the scores of relevant tools, taken per embedder.
- No query translation (`translateQueries: false`).
- Latency is measured on a local machine. Remote embedders include the network round-trip.
- Tool: `tools/measure-tool-rag.ts`. Labels: `tools/tool-rag-queries.json`. Raw per-row JSON: `scratchpad/matrix3/<profile>.detail.json`.

## Labeling rules

1. **`relevant`** = the **primary family**, plus **secondary alternatives**, plus **supporting steps**:
   - Primary family: the tools whose description targets the asked object and operation, including every Read*/Get* twin. Get* is in the writer collection and Read* in the reader collection, so each role can see one of them.
   - Secondary alternatives: tools that also produce the answer. For example, `GetSqlQuery` for table rows, `GetTypeInfo` for table fields, and the package-listing family `GetPackageContents | GetPackageTree | GetObjectsList | GetObjectsByType | GetObjectInfo`.
   - Supporting steps: the natural steps before or after the named one. For example, list a dump, then `RuntimeGetDumpById`/`GetDumpSection`; `RunATC`, then `GetATCFindings`/`GetATCRunStatus`; a run of unit tests, then `GetUnitTest*`; read the source before `Update*`.
   - Not relevant: version-history tools, `Check*`/`Activate*` unless asked, and generic structure or low-level tools.
2. **`required`** = AND of OR-groups. There is one group per step that the query **names explicitly**, or that is a **hard prerequisite** of a named outcome: a service binding needs a service definition. A group lists the interchangeable tools for that step, for example `[ReadClass, GetClass]` or `[ActivateClass, ActivateObjects]`.
   - Unnamed follow-ups stay in `relevant` only. Examples: `UpdateDdl` after "create a CDS view", `GetATCFindings` after "run ATC", and activation that `Update*` can do by itself.
   - Every required tool is also in `relevant`. The script checks this and rejects any label that names a tool not in the corpus.
3. **`expect`** is kept unchanged for compatibility. Four of its names (`RuntimeListDumps`, `ReadView`, `GetView`, `CreateView`) do not exist in the corpus. They were left out of `relevant`/`required`.
4. Only generic names are used: `ZDEMO_*`, `ZCL_DEMO*`, `ZREP_DEMO`, `$TMP`, `DEVK900001`, plus SAP standard objects (MARA, T001, I_PRODUCT, BAPI_USER_GET_DETAIL).

### Thresholds used (score percentiles of RELEVANT tools in the K15 results, non-structural rows)

| backend | t25 | t50 | t75 | relevant score range | all returned p5/p50/p95 |
|---|---|---|---|---|---|
| in-memory keyword | 0.176 | 0.298 | 0.419 | 0–0.527 | 0/0.104/0.357 |
| vector / ollama bge-m3 | 0.341 | 0.507 | 0.64 | 0.278–0.765 | 0.27/0.406/0.618 |
| vector / OpenAI 3-small | 0.223 | 0.45 | 0.579 | 0.114–0.707 | 0.122/0.304/0.554 |
| vector / OpenAI 3-large | 0.183 | 0.374 | 0.528 | 0.097–0.677 | 0.097/0.257/0.512 |
| vector / AI Core 3-small | 0.223 | 0.45 | 0.579 | 0.114–0.707 | 0.122/0.304/0.554 |

## Whole set (68 non-structural query x role rows; 22 structural apart)


**hit (>=1 relevant returned)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.735 | 0.794 | 0.853 | 0.618 | 0.456 | 0.279 |
| vector / ollama bge-m3 | 0.941 | 0.956 | 0.956 | 0.824 | 0.618 | 0.412 |
| vector / OpenAI 3-small | 0.926 | 0.941 | 0.956 | 0.824 | 0.574 | 0.456 |
| vector / OpenAI 3-large | 0.941 | 0.941 | 0.971 | 0.897 | 0.588 | 0.5 |
| vector / AI Core 3-small | 0.926 | 0.941 | 0.956 | 0.824 | 0.574 | 0.456 |

**required-recall (every required group satisfied)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.588 | 0.662 | 0.735 | 0.588 | 0.412 | 0.25 |
| vector / ollama bge-m3 | 0.765 | 0.824 | 0.838 | 0.735 | 0.574 | 0.324 |
| vector / OpenAI 3-small | 0.765 | 0.824 | 0.853 | 0.779 | 0.529 | 0.353 |
| vector / OpenAI 3-large | 0.824 | 0.912 | 0.971 | 0.838 | 0.559 | 0.382 |
| vector / AI Core 3-small | 0.765 | 0.824 | 0.853 | 0.779 | 0.529 | 0.353 |

**recall (relevant returned / relevant visible)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.488 | 0.6 | 0.653 | 0.513 | 0.345 | 0.204 |
| vector / ollama bge-m3 | 0.734 | 0.807 | 0.856 | 0.69 | 0.499 | 0.241 |
| vector / OpenAI 3-small | 0.715 | 0.78 | 0.825 | 0.66 | 0.452 | 0.255 |
| vector / OpenAI 3-large | 0.771 | 0.825 | 0.898 | 0.741 | 0.494 | 0.275 |
| vector / AI Core 3-small | 0.715 | 0.78 | 0.825 | 0.66 | 0.452 | 0.255 |

**precision (relevant returned / returned; rows returning nothing excluded)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.143 | 0.096 | 0.072 | 0.178 | 0.406 | 0.863 |
| vector / ollama bge-m3 | 0.241 | 0.14 | 0.103 | 0.224 | 0.301 | 0.761 |
| vector / OpenAI 3-small | 0.235 | 0.135 | 0.098 | 0.207 | 0.352 | 0.861 |
| vector / OpenAI 3-large | 0.265 | 0.151 | 0.109 | 0.282 | 0.29 | 0.874 |
| vector / AI Core 3-small | 0.235 | 0.135 | 0.098 | 0.207 | 0.352 | 0.861 |

**empty (share of rows that returned no tool)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0 | 0 | 0 | 0.324 | 0.456 | 0.706 |
| vector / ollama bge-m3 | 0 | 0 | 0 | 0.074 | 0.294 | 0.544 |
| vector / OpenAI 3-small | 0 | 0 | 0 | 0.118 | 0.294 | 0.529 |
| vector / OpenAI 3-large | 0 | 0 | 0 | 0.059 | 0.294 | 0.5 |
| vector / AI Core 3-small | 0 | 0 | 0 | 0.118 | 0.294 | 0.529 |

**avg tools returned (x ~260 = prompt tokens)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 8.3 (~2.2k) | 16.6 (~4.3k) | 24.9 (~6.5k) | 8.4 (~2.2k) | 2.7 (~0.7k) | 0.5 (~0.1k) |
| vector / ollama bge-m3 | 8.3 (~2.2k) | 16.6 (~4.3k) | 24.9 (~6.5k) | 16 (~4.2k) | 5.7 (~1.5k) | 0.9 (~0.2k) |
| vector / OpenAI 3-small | 8.3 (~2.2k) | 16.6 (~4.3k) | 24.9 (~6.5k) | 16.8 (~4.4k) | 4.3 (~1.1k) | 0.8 (~0.2k) |
| vector / OpenAI 3-large | 8.3 (~2.2k) | 16.6 (~4.3k) | 24.9 (~6.5k) | 16.8 (~4.4k) | 5.9 (~1.5k) | 0.9 (~0.2k) |
| vector / AI Core 3-small | 8.3 (~2.2k) | 16.6 (~4.3k) | 24.9 (~6.5k) | 16.8 (~4.4k) | 4.3 (~1.1k) | 0.8 (~0.2k) |

**MRR of first relevant (score-ordered)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.551 | 0.556 | 0.56 | 0.496 | 0.426 | 0.272 |
| vector / ollama bge-m3 | 0.802 | 0.803 | 0.803 | 0.728 | 0.536 | 0.392 |
| vector / OpenAI 3-small | 0.835 | 0.837 | 0.838 | 0.732 | 0.555 | 0.456 |
| vector / OpenAI 3-large | 0.841 | 0.841 | 0.843 | 0.781 | 0.557 | 0.483 |
| vector / AI Core 3-small | 0.835 | 0.837 | 0.838 | 0.732 | 0.555 | 0.456 |

## Non-ASCII (Ukrainian) subset (26 rows; 4 structural apart)


**hit (>=1 relevant returned)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.346 | 0.462 | 0.615 | 0 | 0 | 0 |
| vector / ollama bge-m3 | 0.885 | 0.885 | 0.885 | 0.538 | 0 | 0 |
| vector / OpenAI 3-small | 0.846 | 0.885 | 0.885 | 0.538 | 0 | 0 |
| vector / OpenAI 3-large | 0.885 | 0.885 | 0.923 | 0.731 | 0 | 0 |
| vector / AI Core 3-small | 0.846 | 0.885 | 0.885 | 0.538 | 0 | 0 |

**required-recall (every required group satisfied)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.154 | 0.231 | 0.308 | 0 | 0 | 0 |
| vector / ollama bge-m3 | 0.577 | 0.654 | 0.692 | 0.423 | 0 | 0 |
| vector / OpenAI 3-small | 0.538 | 0.692 | 0.692 | 0.5 | 0 | 0 |
| vector / OpenAI 3-large | 0.731 | 0.846 | 0.923 | 0.577 | 0 | 0 |
| vector / AI Core 3-small | 0.538 | 0.692 | 0.692 | 0.5 | 0 | 0 |

**recall (relevant returned / relevant visible)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.072 | 0.168 | 0.272 | 0 | 0 | 0 |
| vector / ollama bge-m3 | 0.62 | 0.714 | 0.781 | 0.348 | 0 | 0 |
| vector / OpenAI 3-small | 0.567 | 0.653 | 0.697 | 0.264 | 0 | 0 |
| vector / OpenAI 3-large | 0.71 | 0.778 | 0.852 | 0.442 | 0 | 0 |
| vector / AI Core 3-small | 0.567 | 0.653 | 0.697 | 0.264 | 0 | 0 |

**precision (relevant returned / returned; rows returning nothing excluded)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.05 | 0.04 | 0.038 | 0 | 0 | 0 |
| vector / ollama bge-m3 | 0.262 | 0.162 | 0.123 | 0.452 | 0 | 0 |
| vector / OpenAI 3-small | 0.242 | 0.142 | 0.106 | 0.458 | 0 | 0 |
| vector / OpenAI 3-large | 0.319 | 0.185 | 0.129 | 0.624 | 0 | 0 |
| vector / AI Core 3-small | 0.242 | 0.142 | 0.106 | 0.458 | 0 | 0 |

**empty (share of rows that returned no tool)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0 | 0 | 0 | 0.846 | 0.923 | 1 |
| vector / ollama bge-m3 | 0 | 0 | 0 | 0.192 | 0.769 | 0.923 |
| vector / OpenAI 3-small | 0 | 0 | 0 | 0.308 | 0.769 | 1 |
| vector / OpenAI 3-large | 0 | 0 | 0 | 0.154 | 0.769 | 1 |
| vector / AI Core 3-small | 0 | 0 | 0 | 0.308 | 0.769 | 1 |

**avg tools returned (x ~260 = prompt tokens)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 7.9 (~2.1k) | 15.8 (~4.1k) | 23.7 (~6.2k) | 1.2 (~0.3k) | 0.2 (~0.1k) | 0 (~0.0k) |
| vector / ollama bge-m3 | 7.9 (~2.1k) | 15.8 (~4.1k) | 23.7 (~6.2k) | 4.7 (~1.2k) | 1.5 (~0.4k) | 0.1 (~0.0k) |
| vector / OpenAI 3-small | 7.9 (~2.1k) | 15.8 (~4.1k) | 23.7 (~6.2k) | 4.9 (~1.3k) | 0.9 (~0.2k) | 0 (~0.0k) |
| vector / OpenAI 3-large | 7.9 (~2.1k) | 15.8 (~4.1k) | 23.7 (~6.2k) | 4.9 (~1.3k) | 1.2 (~0.3k) | 0 (~0.0k) |
| vector / AI Core 3-small | 7.9 (~2.1k) | 15.8 (~4.1k) | 23.7 (~6.2k) | 4.9 (~1.3k) | 0.9 (~0.2k) | 0 (~0.0k) |

**MRR of first relevant (score-ordered)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.145 | 0.157 | 0.168 | 0 | 0 | 0 |
| vector / ollama bge-m3 | 0.7 | 0.699 | 0.699 | 0.503 | 0 | 0 |
| vector / OpenAI 3-small | 0.717 | 0.721 | 0.721 | 0.446 | 0 | 0 |
| vector / OpenAI 3-large | 0.729 | 0.729 | 0.732 | 0.569 | 0 | 0 |
| vector / AI Core 3-small | 0.717 | 0.721 | 0.721 | 0.446 | 0 | 0 |

## Multi-step subset (19 rows; 9 structural apart)


**required-recall (every required group satisfied)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.211 | 0.316 | 0.474 | 0.368 | 0.211 | 0.105 |
| vector / ollama bge-m3 | 0.368 | 0.526 | 0.579 | 0.421 | 0.316 | 0.105 |
| vector / OpenAI 3-small | 0.474 | 0.684 | 0.737 | 0.579 | 0.316 | 0.053 |
| vector / OpenAI 3-large | 0.579 | 0.895 | 1 | 0.632 | 0.368 | 0.053 |
| vector / AI Core 3-small | 0.474 | 0.684 | 0.737 | 0.579 | 0.316 | 0.053 |

**recall (relevant returned / relevant visible)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.276 | 0.391 | 0.501 | 0.338 | 0.228 | 0.115 |
| vector / ollama bge-m3 | 0.527 | 0.648 | 0.721 | 0.476 | 0.302 | 0.163 |
| vector / OpenAI 3-small | 0.551 | 0.676 | 0.724 | 0.45 | 0.292 | 0.124 |
| vector / OpenAI 3-large | 0.64 | 0.732 | 0.788 | 0.485 | 0.32 | 0.145 |
| vector / AI Core 3-small | 0.551 | 0.676 | 0.724 | 0.45 | 0.292 | 0.124 |

**precision (relevant returned / returned; rows returning nothing excluded)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 0.158 | 0.116 | 0.1 | 0.259 | 0.46 | 0.72 |
| vector / ollama bge-m3 | 0.284 | 0.182 | 0.137 | 0.336 | 0.338 | 0.76 |
| vector / OpenAI 3-small | 0.311 | 0.187 | 0.137 | 0.246 | 0.385 | 0.881 |
| vector / OpenAI 3-large | 0.353 | 0.213 | 0.154 | 0.321 | 0.329 | 0.89 |
| vector / AI Core 3-small | 0.311 | 0.187 | 0.137 | 0.246 | 0.385 | 0.881 |

**avg tools returned (x ~260 = prompt tokens)**

| backend | K5 | K10 | K15 | t25 | t50 | t75 |
|---|---|---|---|---|---|---|
| in-memory keyword | 8.7 (~2.3k) | 17.4 (~4.5k) | 26.1 (~6.8k) | 7.8 (~2.0k) | 3.1 (~0.8k) | 0.7 (~0.2k) |
| vector / ollama bge-m3 | 8.7 (~2.3k) | 17.4 (~4.5k) | 26.1 (~6.8k) | 14.1 (~3.7k) | 5.4 (~1.4k) | 1.4 (~0.4k) |
| vector / OpenAI 3-small | 8.7 (~2.3k) | 17.4 (~4.5k) | 26.1 (~6.8k) | 14.9 (~3.9k) | 4.4 (~1.1k) | 0.9 (~0.2k) |
| vector / OpenAI 3-large | 8.7 (~2.3k) | 17.4 (~4.5k) | 26.1 (~6.8k) | 14.8 (~3.8k) | 5.7 (~1.5k) | 1.2 (~0.3k) |
| vector / AI Core 3-small | 8.7 (~2.3k) | 17.4 (~4.5k) | 26.1 (~6.8k) | 14.9 (~3.9k) | 4.4 (~1.1k) | 0.9 (~0.2k) |

## Latency, whole set (ms; thresholds reuse the K15 query)

| backend | K5 p50/p95 | K10 p50/p95 | K15 p50/p95 |
|---|---|---|---|
| in-memory keyword | 0.1/0.2 | 0.1/0.2 | 0.1/0.1 |
| vector / ollama bge-m3 | 81.3/95.5 | 81.3/86.8 | 81/88 |
| vector / OpenAI 3-small | 211.3/353.5 | 213.6/306.2 | 235.7/341.8 |
| vector / OpenAI 3-large | 276.6/383.1 | 286.8/395.8 | 276.1/387.4 |
| vector / AI Core 3-small | 640.6/1131.1 | 655.4/1299.8 | 633.6/922.9 |

## Exploratory, computed offline: relative cut instead of an absolute threshold

This keeps a tool when its score is at least ratio x the top score **of its own collection**, taken from the same K15 data. It is language-neutral because it only compares a query's scores with each other. Whole set (non-ASCII in parentheses):

| backend | ratio 0.8: req-recall / avg tools | 0.85 | 0.9 |
|---|---|---|---|
| bge-m3 | 0.82 (0.65) / 12.4 | 0.81 (0.65) / 10.2 | 0.77 (0.62) / 6.8 |
| OpenAI 3-small = AI Core | 0.75 (0.50) / 7.2 | 0.72 (0.46) / 5.2 | 0.65 (0.38) / 3.6 |
| OpenAI 3-large | 0.77 (0.62) / 6.2 | 0.74 (0.58) / 4.7 | 0.63 (0.46) / 3.6 |

- Unlike the absolute thresholds, the relative cut does not collapse on Ukrainian queries.
- It still does not beat a plain K5 per token. For 3-large, K5 gives 0.82 at 8.3 tools and ratio 0.8 gives 0.77 at 6.2 tools.
- It is worth noting as an option, but it is not a clear win.

## Failures common to every embedder (corpus and query defects)

**Required group missing at K15 for all four vector embedders** (the keyword backend also misses both):

1. `[Developer] Створи домен ZDEMO_D_TEST у пакеті $TMP`: CreateDomain is not in the writer top-15.
2. `[Developer] Видали таблицю ZDEMO_T_TEST з $TMP`: DeleteTable is not in the writer top-15.

The writer top-15 for both is entirely the unit-test family (`CreateCdsUnitTest`, `UpdateCdsUnitTest`, `DeleteUnitTest`, `UpdateLocalTestClass`, `RunUnitTest`, and so on). A probe run with the same embedders (`probe-queries.json`) shows the rank of the target tool:

| probe query | bge-m3 | OpenAI 3-large | AI Core 3-small |
|---|---|---|---|
| Створи домен ZDEMO_D_TEST у пакеті $TMP | miss | miss | miss |
| Створи домен ZDEMO_D_TEST (no $TMP) | miss | miss | miss |
| Створи домен ZDEMO_D_STATUS у пакеті $TMP | miss | in writer top-15 | in writer top-15 |
| Create domain ZDEMO_D_TEST in package $TMP | #1 | #1 | #1 |
| Видали таблицю ZDEMO_T_TEST з $TMP | miss | miss | miss |
| Видали таблицю ZDEMO_T_ORDER з $TMP | in writer top-15 | in writer top-15 | in writer top-15 |

What the probe shows:

- **`$TMP` is not the cause** in this corpus. Removing it does not help.
- **The cause is the `TEST` token in the object name, combined with a Ukrainian verb.** The English verb outweighs `TEST`; the Ukrainian "Створи"/"Видали" does not.
- **The unit-test family acts as a "hub" in the writer collection.** Its test/class-heavy intents surface for many unrelated Create* and Update* queries.
- **Fix at the source, in the intents:**
  - Narrow the unit-test intents to test runs and test classes.
  - Give Create*/Delete* intents Ukrainian-neutral verb anchors.
  - Deduplicate `CreateUnitTest` against `RunUnitTest`: they have identical descriptions and intents, so they take two slots.

**Required group missing at K5 for all four vector embedders** (these point at a weak or noisy intent):

- `Add class ZCL_DEMO to transport DEVK900001`: AddTransportObject is at writer rank 10–14. The object name `ZCL_…`/"class" pulls in `CreateMessageClassMessage`, `UpdateClass` and the message-class tools. The AddTransportObject intent should say "add/assign an object (class, program…) to a transport request".
- `Створи транспорт … і додай туди клас ZCL_DEMO` (multi): the same AddTransportObject weakness.
- `Покажи функціональний модуль BAPI_USER_GET_DETAIL` (Reader): ReadFunctionModule is at reader rank 11 (3-large) or not in the top-15 (bge-m3). The `USER` token pulls `ListTransports` (user parameter), `RuntimeGetGatewayErrorLog` and `RuntimeListSystemMessages`. The Ukrainian noun "функціональний модуль" is weak against these.
- `Прочитай останній дамп і відкрий програму …` (multi, both roles): `RuntimeListFeeds` ranks below `RuntimeGetDumpById` and `GetDumpSection`, whose intents say "dump" more strongly. Its intent is generic ("feeds"). The single-step `Покажи короткі дампи за сьогодні` misses it entirely with 3-small / AI Core, even at K15. With "ST22" added to the query, it only just gets back in, at score-rank 15.
- `Створи клас ZCL_DEMO_X у $TMP, додай метод і активуй`: UpdateClass is at writer rank 5–6, behind `UpdateLocalTestClass` and `CreateMessageClass` (the same "class"/test hub).
- `Create a CDS view ZI_DEMO_ITEM and a service binding for it`: the four ServiceBinding tools fill the writer top-5. CreateDdl and CreateServiceDefinition are at rank 9–13. This is inherent to a query with two objects.
- `Find where-used … and show the source of the users`: no source reader in the top-5. This is expected, because the query does not name an object type.

## Recommendation (per embedder)

Tokens are ~260 per tool and are averaged over roles. A Developer pays twice what a Reader pays.

| backend | recommended cut | req-recall (non-ASCII) | avg tools / tokens | alternative if context is tight |
|---|---|---|---|---|
| OpenAI 3-large | **K10** | 0.91 (0.85) | 16.6 / ~4.3k | K5: 0.82 (0.73), 8.3 / ~2.2k. K15 reaches 0.97 but costs ~6.5k |
| OpenAI 3-small / AI Core | **K10** | 0.82 (0.69) | 16.6 / ~4.3k | K5: 0.77 (0.54). K15 adds only +0.03 |
| ollama bge-m3 | **K10** | 0.82 (0.65) | 16.6 / ~4.3k | K5: 0.77 (0.58). K15 adds only +0.01 |
| in-memory keyword | none is adequate | 0.66 (0.23) at K10 | — | use a vector embedder whenever Ukrainian queries are possible |

- **Thresholds.**
  - t25 roughly matches K10's size (~16–17 tools) but with lower required-recall than K10 for every embedder.
  - From t50 up, the non-ASCII subset collapses to 0.
  - A global absolute threshold should not replace the per-collection K.
- **Small-context local LLM.** Use bge-m3 at K5 (~2.2k tokens on average, 2.6k for a Developer) and accept required-recall 0.77. The next gain is fixing the intent defects above, not raising K. The two `_TEST` misses and the AddTransportObject / RuntimeListFeeds weaknesses stay unfixed even at K15.
- **Precision is low at every K** (0.10–0.27). Most returned tools are not relevant. This is inherent to the design of top-K per collection with 1–3 relevant tools per query. The token cost is driven by K, not by the embedder.
