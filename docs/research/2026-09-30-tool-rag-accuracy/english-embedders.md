# Spike: English tool-RAG accuracy — model vs scoring vs descriptions

## TL;DR

- **Descriptions are the biggest lever and are model-independent.** C → RC (18 rewritten descriptions) adds **+8.2 points** of EN-ext required-recall at K5 on average (range +5.8 to +12.8), and +4.1 on EN-orig. It helps every model under both scoring modes.
- **Scoring mode and model interact; neither is a lever on its own.**
  - Under hybrid (0.7 cosine + 0.3 BM25), all 7 models land within 3.5 points (C) or 1.2 points (RC) of each other. BM25 flattens the model differences.
  - Under cosine-only, the models spread by 7 points (C) to 13 points (RC). The English retrieval-tuned models (bge-large-en-v1.5, mxbai) are the best cosine models. bge-m3, nomic and 3-small lose 5–10 points without BM25.
- **Best measured configuration:** English retrieval model + cosine + RC.
  - mxbai with a query prefix scores 0.965 (K5).
  - bge-large-en-v1.5 scores 0.953, with or without the prefix.
  - The best hybrid configuration scores 0.942.
  - On EN-orig (queries independent of the rewrites), bge-large + cosine is the best configuration even with the current C descriptions: 0.929 against 0.857–0.905 for the others.
- **Role-aware prefixes:**
  - bge-large: no effect (0.0 in every cell).
  - mxbai and nomic: +3.5 points, and only under cosine + RC.
  - snowflake-arctic-embed: mandatory. Without the prefix, cosine collapses to 0.28 (a 55–64 point loss), because the queries land near generic "check/activate" docs.
  - Under hybrid, prefixes are worth 0 to +1 point.
- **No NaN or zero vectors** in any model's run or cache. The bge-m3 cache is the CPU-embedded one from spike-docs, and it is reused. The NaN detector plus CPU re-embed (`run.ts: bad()`/`ollamaOne`) never fired.

## Setup

- **Harness:** `run.ts`. It is the spike-docs harness restricted to C/RC and English queries, with cuts at K3, K5 and K10.
  - Same BM25 tokenizer, same 0.7/0.3 fusion, per-collection top-K (reader/writer) and structural-row exclusion.
- **Reproduction:** the bge-m3, 3-small and 3-large C/RC numbers match `spike-docs/report.md` exactly in both scoring modes, on EN-ext K5/K10 and EN-orig.
- **Query sets:**
  - EN-orig = 30 ASCII queries → 42 rows.
  - EN-ext = EN-orig + 28 added queries → 86 rows, of which 72 single-step and 14 multi-step.
  - 1 row = 1.2 points on EN-ext and 2.4 points on EN-orig. Differences of 1–2 rows are noise.
  - The added queries were written after the weak spots were seen, so treat EN-ext as optimistic for RC.
- **Prefixes:**
  - nomic: `search_query: ` / `search_document: `.
  - bge-large-en-v1.5 (ollama `bge-large`, confirmed as `bge en v1.5`), mxbai and snowflake: the query instruction "Represent this sentence for searching relevant passages: " on queries only.
  - bge-m3 and OpenAI need no prefix.
  - BM25 always runs on the raw text.
- **Context:** the 512-token context of the English models is not a factor. The longest production doc is 1838 chars.

## headline EN-ext req K5 (K10)
| model | prefixes | C hybrid | C cosine | RC hybrid | RC cosine |
|---|---|---|---|---|---|
| bge-m3 | no | 0.849 (0.895) | 0.791 (0.895) | 0.930 (0.965) | 0.884 (0.965) |
| nomic-embed-text | no | 0.860 (0.919) | 0.767 (0.872) | 0.942 (0.988) | 0.802 (0.907) |
| nomic-embed-text | yes | 0.860 (0.895) | 0.779 (0.872) | 0.942 (0.965) | 0.837 (0.930) |
| bge-large-en-v1.5 | no | 0.860 (0.907) | 0.849 (0.930) | 0.930 (0.965) | 0.953 (0.965) |
| bge-large-en-v1.5 | yes | 0.860 (0.907) | 0.849 (0.919) | 0.930 (0.965) | 0.953 (0.965) |
| mxbai-embed-large | no | 0.860 (0.907) | 0.849 (0.930) | 0.930 (0.965) | 0.930 (0.965) |
| mxbai-embed-large | yes | 0.860 (0.907) | 0.837 (0.907) | 0.930 (0.965) | 0.965 (0.965) |
| snowflake-arctic-embed-335m | no | 0.826 (0.907) | 0.279 (0.419) | 0.907 (0.965) | 0.279 (0.384) |
| snowflake-arctic-embed-335m | yes | 0.837 (0.907) | 0.826 (0.919) | 0.930 (0.965) | 0.919 (0.965) |
| oai-3-small | no | 0.872 (0.884) | 0.802 (0.907) | 0.942 (0.977) | 0.860 (0.930) |
| oai-3-large | no | 0.860 (0.907) | 0.849 (0.953) | 0.942 (1.000) | 0.919 (1.000) |

## same, EN-orig (queries independent of the rewrites)
| model | prefixes | C hybrid | C cosine | RC hybrid | RC cosine |
|---|---|---|---|---|---|
| bge-m3 | no | 0.857 (0.929) | 0.786 (0.881) | 0.905 (0.929) | 0.857 (0.952) |
| nomic-embed-text | no | 0.881 (0.952) | 0.690 (0.881) | 0.905 (0.976) | 0.714 (0.833) |
| nomic-embed-text | yes | 0.881 (0.929) | 0.762 (0.881) | 0.905 (0.929) | 0.786 (0.881) |
| bge-large-en-v1.5 | no | 0.881 (0.929) | 0.929 (0.929) | 0.905 (0.929) | 0.952 (0.952) |
| bge-large-en-v1.5 | yes | 0.881 (0.929) | 0.929 (0.929) | 0.905 (0.929) | 0.952 (0.952) |
| mxbai-embed-large | no | 0.881 (0.929) | 0.881 (0.929) | 0.905 (0.929) | 0.905 (0.952) |
| mxbai-embed-large | yes | 0.881 (0.929) | 0.881 (0.929) | 0.905 (0.929) | 0.952 (0.952) |
| snowflake-arctic-embed-335m | no | 0.833 (0.929) | 0.214 (0.357) | 0.857 (0.929) | 0.214 (0.333) |
| snowflake-arctic-embed-335m | yes | 0.833 (0.929) | 0.857 (0.929) | 0.881 (0.929) | 0.905 (0.929) |
| oai-3-small | no | 0.905 (0.905) | 0.810 (0.881) | 0.929 (0.952) | 0.833 (0.905) |
| oai-3-large | no | 0.881 (0.952) | 0.857 (0.976) | 0.905 (1.000) | 0.952 (1.000) |

## best per model (EN-ext)
| model | best config | req K3 | req K5 | req K10 | prec K3 | avgRet K3 | prec K5 | avgRet K5 | recall K5 | MRR K5 |
|---|---|---|---|---|---|---|---|---|---|---|
| bge-m3 | RC hybrid, prefix no | 0.872 | 0.930 | 0.965 | 0.341 | 5 | 0.233 | 8.4 | 0.857 | 0.864 |
| nomic-embed-text | RC hybrid, prefix no | 0.860 | 0.942 | 0.988 | 0.339 | 5 | 0.235 | 8.4 | 0.868 | 0.836 |
| bge-large-en-v1.5 | RC cosine, prefix yes | 0.884 | 0.953 | 0.965 | 0.324 | 5 | 0.233 | 8.4 | 0.861 | 0.840 |
| mxbai-embed-large | RC cosine, prefix yes | 0.837 | 0.965 | 0.965 | 0.318 | 5 | 0.229 | 8.4 | 0.861 | 0.838 |
| snowflake-arctic-embed-335m | RC hybrid, prefix yes | 0.884 | 0.930 | 0.965 | 0.343 | 5 | 0.230 | 8.4 | 0.859 | 0.848 |
| oai-3-small | RC hybrid, prefix no | 0.872 | 0.942 | 0.977 | 0.331 | 5 | 0.240 | 8.4 | 0.877 | 0.897 |
| oai-3-large | RC hybrid, prefix no | 0.860 | 0.942 | 1.000 | 0.339 | 5 | 0.240 | 8.4 | 0.876 | 0.880 |

## Embedding latency per query (58 EN queries, single text per call, sequential, after warm-up, RTX 4060 laptop)

| model | p50 ms | p95 ms |
|---|---|---|
| bge-m3 (GPU) | 97 | 112 |
| bge-m3 (CPU, as used for the cache) | 137 | 193 |
| nomic-embed-text | 17 | 23 |
| bge-large-en-v1.5 | 18 | 28 |
| mxbai-embed-large | 19 | 27 |
| snowflake-arctic-embed:335m | 16 | 20 |
| OpenAI 3-small (network) | 260 | 291 |
| OpenAI 3-large (network) | 348 | 1771 |


## top configs single vs multi (req K3/K5/K10)
| config | single n | single | multi n | multi |
|---|---|---|---|---|
| mxbai-embed-large RC cosine pfx=prefix | 72 | 0.972/1.000/1.000 | 14 | 0.143/0.786/0.786 |
| bge-large-en-v1.5 RC cosine pfx=prefix | 72 | 0.958/1.000/1.000 | 14 | 0.500/0.714/0.786 |
| bge-large-en-v1.5 RC cosine pfx=none | 72 | 0.931/1.000/1.000 | 14 | 0.500/0.714/0.786 |
| oai-3-large RC hybrid pfx=none | 72 | 0.958/0.986/1.000 | 14 | 0.357/0.714/1.000 |
| nomic-embed-text RC hybrid pfx=none | 72 | 0.944/0.986/1.000 | 14 | 0.429/0.714/0.929 |
| oai-3-small RC hybrid pfx=none | 72 | 0.958/0.986/1.000 | 14 | 0.429/0.714/0.857 |

## decomposition en-ext K5 (points)
descriptions C->RC (correct prefix, all models x scoring): mean 8.2 min 5.8 max 12.8
hybrid-cosine: mean 3.4 min -3.5 max 10.5 [('bge-m3', 'C', 5.8), ('bge-m3', 'RC', 4.6), ('nomic-embed-text', 'C', 8.1), ('nomic-embed-text', 'RC', 10.5), ('bge-large-en-v1.5', 'C', 1.1), ('bge-large-en-v1.5', 'RC', -2.3), ('mxbai-embed-large', 'C', 2.3), ('mxbai-embed-large', 'RC', -3.5), ('snowflake-arctic-embed-335m', 'C', 1.1), ('snowflake-arctic-embed-335m', 'RC', 1.1), ('oai-3-small', 'C', 7.0), ('oai-3-small', 'RC', 8.2), ('oai-3-large', 'C', 1.1), ('oai-3-large', 'RC', 2.3)]
prefix-none: [('nomic-embed-text', 0.0), ('nomic-embed-text', 1.2), ('nomic-embed-text', 0.0), ('nomic-embed-text', 3.5), ('bge-large-en-v1.5', 0.0), ('bge-large-en-v1.5', 0.0), ('bge-large-en-v1.5', 0.0), ('bge-large-en-v1.5', 0.0), ('mxbai-embed-large', 0.0), ('mxbai-embed-large', -1.2), ('mxbai-embed-large', 0.0), ('mxbai-embed-large', 3.5), ('snowflake-arctic-embed-335m', 1.1), ('snowflake-arctic-embed-335m', 54.7), ('snowflake-arctic-embed-335m', 2.3), ('snowflake-arctic-embed-335m', 64.0)]
model spread C hybrid: bge-m3=0.849 nomic-embed-text=0.860 bge-large-en-v1.5=0.860 mxbai-embed-large=0.860 snowflake-arctic-embed-335m=0.837 oai-3-small=0.872 oai-3-large=0.860 range 3.5
model spread C cosine: bge-m3=0.791 nomic-embed-text=0.779 bge-large-en-v1.5=0.849 mxbai-embed-large=0.837 snowflake-arctic-embed-335m=0.826 oai-3-small=0.802 oai-3-large=0.849 range 7.0
model spread RC hybrid: bge-m3=0.930 nomic-embed-text=0.942 bge-large-en-v1.5=0.930 mxbai-embed-large=0.930 snowflake-arctic-embed-335m=0.930 oai-3-small=0.942 oai-3-large=0.942 range 1.2
model spread RC cosine: bge-m3=0.884 nomic-embed-text=0.837 bge-large-en-v1.5=0.953 mxbai-embed-large=0.965 snowflake-arctic-embed-335m=0.919 oai-3-small=0.860 oai-3-large=0.919 range 12.8

## decomposition en-orig K5 (points)
descriptions C->RC (correct prefix, all models x scoring): mean 4.1 min 2.3 max 9.5
hybrid-cosine: mean 2.4 min -4.8 max 11.9 [('bge-m3', 'C', 7.1), ('bge-m3', 'RC', 4.8), ('nomic-embed-text', 'C', 11.9), ('nomic-embed-text', 'RC', 11.9), ('bge-large-en-v1.5', 'C', -4.8), ('bge-large-en-v1.5', 'RC', -4.7), ('mxbai-embed-large', 'C', 0.0), ('mxbai-embed-large', 'RC', -4.7), ('snowflake-arctic-embed-335m', 'C', -2.4), ('snowflake-arctic-embed-335m', 'RC', -2.4), ('oai-3-small', 'C', 9.5), ('oai-3-small', 'RC', 9.6), ('oai-3-large', 'C', 2.4), ('oai-3-large', 'RC', -4.7)]
prefix-none: [('nomic-embed-text', 0.0), ('nomic-embed-text', 7.2), ('nomic-embed-text', 0.0), ('nomic-embed-text', 7.2), ('bge-large-en-v1.5', 0.0), ('bge-large-en-v1.5', 0.0), ('bge-large-en-v1.5', 0.0), ('bge-large-en-v1.5', 0.0), ('mxbai-embed-large', 0.0), ('mxbai-embed-large', 0.0), ('mxbai-embed-large', 0.0), ('mxbai-embed-large', 4.7), ('snowflake-arctic-embed-335m', 0.0), ('snowflake-arctic-embed-335m', 64.3), ('snowflake-arctic-embed-335m', 2.4), ('snowflake-arctic-embed-335m', 69.1)]
model spread C hybrid: bge-m3=0.857 nomic-embed-text=0.881 bge-large-en-v1.5=0.881 mxbai-embed-large=0.881 snowflake-arctic-embed-335m=0.833 oai-3-small=0.905 oai-3-large=0.881 range 7.2
model spread C cosine: bge-m3=0.786 nomic-embed-text=0.762 bge-large-en-v1.5=0.929 mxbai-embed-large=0.881 snowflake-arctic-embed-335m=0.857 oai-3-small=0.810 oai-3-large=0.857 range 16.7
model spread RC hybrid: bge-m3=0.905 nomic-embed-text=0.905 bge-large-en-v1.5=0.905 mxbai-embed-large=0.905 snowflake-arctic-embed-335m=0.881 oai-3-small=0.929 oai-3-large=0.905 range 4.8
model spread RC cosine: bge-m3=0.857 nomic-embed-text=0.786 bge-large-en-v1.5=0.952 mxbai-embed-large=0.952 snowflake-arctic-embed-335m=0.905 oai-3-small=0.833 oai-3-large=0.952 range 16.6

## Decomposition (EN-ext required-recall at K5, in points; baseline bge-m3 / hybrid / C = 0.849)

| factor | effect | notes |
|---|---|---|
| **Descriptions C → RC** | **+8.2 mean** (+5.8…+12.8); EN-orig +4.1 | Helps every model and both scoring modes. The only lever that is always positive. |
| **Scoring (hybrid − cosine)** | +3.4 mean, but the sign depends on the model: −3.5…+10.5 | See the breakdown below. |
| **Model choice** | ≤ 3.5 under hybrid (1.2 with RC); 7–13 under cosine | On its own, the best model move from the baseline is +2.3 (3-small). Model and scoring must be chosen together. |
| **Query/doc prefixes** | 0 (bge-large); +3.5 (mxbai/nomic, cosine+RC only); mandatory for snowflake | Under hybrid, 0 to +1. |

Hybrid − cosine by model:
- It helps multilingual / general models: bge-m3 +5, nomic +8…+10, 3-small +7…+8.
- It is neutral or harmful for English retrieval-tuned models: bge-large −2.3, mxbai −3.5 (RC), 3-large +1…+2 on EN-ext.
- On EN-orig it is −4.7 for bge-large, mxbai and 3-large.

Best end-to-end moves from the baseline:
- Descriptions alone: 0.849 → 0.930 (+8.1).
- Then model + scoring: bge-large cosine → 0.953 (+2.3), or mxbai + query prefix cosine → 0.965 (+3.5).

## Recommendation

1. **Local preset: bge-large-en-v1.5 (ollama `bge-large`), cosine-only scoring (no BM25 half), no prefix wiring needed.**
   - Quality:
     - RC: 0.953 at K5 and 0.965 at K10.
     - C: 0.849 at K5 and 0.930 at K10; on EN-orig it is the best configuration even with C (0.929 at K5).
   - Speed: 18 ms per query against 97 ms for bge-m3. It has no NaN issue.
   - Cosine-only also removes the BM25 `_TEST` / `BAPI_USER` swamp found in spike-docs.
   - mxbai + query prefix is +1 row at K5 but weaker at K3, especially on multi-step (0.143 against 0.500). It is not worth wiring embedder roles for.
   - Caveat: the model is English-only. If the local preset must serve Ukrainian queries, keep bge-m3 + hybrid. That configuration is 2.3 points lower on EN with RC.
2. **BTP production: land the 18 description rewrites upstream in lib first.** That is +6 to +9 points for whichever embedder is used.
   - Then prefer text-embedding-3-large.
     - RC: 0.942 hybrid / 0.919 cosine at K5, and 1.000 at K10 in both modes.
     - On EN-orig, cosine is better: 0.952 against 0.905.
   - 3-large + cosine (or hybrid with identifier tokens kept out of BM25) at K ≥ 10 is the target.
   - If production stays on 3-small, keep hybrid: cosine costs 7–10 points there.
   - Role-aware embedding is not needed for either OpenAI model.

Files: `run.ts`, `latency.ts`, `tables.py`, `base.json` / `new.json` (all metrics), `latency.json`, `snowcheck.ts` (the snowflake no-prefix sanity check).
