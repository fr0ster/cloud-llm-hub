# Reranker spike — does a stage-2 reranker improve the hub's tool retrieval?

TL;DR: **Yes, Cohere Rerank (R3) does; the LlmReranker (R2) does not.** With text-embedding-3-small hybrid,
K1=30 per collection, then Cohere top-5 per collection plus a per-clause union for multi-step queries (R3c):
EN-ext required-recall is **0.977 with 9.4 tools**. Production today (R0 K15) gets the same 0.977 but sends 25 tools.
That is about 15.6 fewer tools, or roughly 4,000 fewer prompt tokens per request, for about 0.4–0.8 s of rerank latency.

## Setup
- Corpus: main @ lib 15.1.0, 237 tools. It was re-dumped with `dump-corpus.ts`, using the same production text the hub embeds.
  Compared with the lib-15 spike, 4 doc texts changed and GetUnitTestResult moved to `readonly`.
- Queries, metrics, BM25, tokenizer and per-collection top-K concatenation are copied from `lib15/spike/run.ts`. Structural rows are excluded.
  EN-ext = 87 rows (73 single-step, 14 multi-step). Non-ASCII = 26 rows. Rows are per role (Reader / Developer).
- R0 numbers differ slightly from the lib-15 spike (hybrid K5 0.919 → 0.943), because the corpus and the query file on main changed.
- Stage 1: text-embedding-3-small, cached vectors, embedded via OpenAI. It is the same model as the AI Core embedder.
  Scoring is hybrid (0.7 cosine + 0.3 BM25) or cosine-only, with K1 ∈ {30, 50} per collection (reader, writer).
- R2: the **real** `LlmReranker` class, over `makeHubLlm({provider:'sap-ai-sdk', model, resourceGroup:'default'})`, temperature 0.
  Models: AI Core gpt-4o-mini, and gpt-4.1-mini at K1=30 only.
- R3: Cohere `cohere-reranker` on AI Core via `{deploymentUrl}/rerank`. Its scores do not depend on the batch,
  so every (query or clause, tool) pair was scored once (122 calls × 237 docs) and cached.
  Latency was measured separately on real K1=30/50 per-collection sets (80 fresh calls).
- R1 (local bge-reranker via TEI) was **dropped** on scope change. The container, image and model data have been removed.
- Pluggable rerankers: `run2.ts` has `Reranker.score(query, cands) => scores`. Adding another one means adding one object.

## Headline — EN-ext, required-recall / precision / avg tools returned
| stage 1 | rerank | K1 | k2=3 | k2=5 | k2=8 |
|---|---|---|---|---|---|
| hybrid | R0 | – | 0.885 / .324 / 5 | 0.943 / .225 / 8.3 | 0.943 / .154 / 13.3 (K10 .954/16.7, **K15 .977/25**) |
| hybrid | R3 Cohere | 30 | 0.908 / .368 / 5 | 0.931 / .246 / 8.3 | 0.943 / .158 / 13.3 |
| hybrid | **R3c (clause union)** | 30 | 0.943 / .350 / 5.7 | **0.977 / .234 / 9.4** | 0.977 / .150 / 14.9 |
| hybrid | R3 | 50 | 0.908 / .368 / 5 | 0.931 / .247 / 8.3 | 0.954 / .159 / 13.3 |
| hybrid | R2 gpt-4o-mini | 30 | 0.897 / .337 / 5 | 0.931 / .221 / 8.3 | 0.931 / .149 / 13.3 |
| hybrid | R2 gpt-4o-mini | 50 | 0.897 / .341 / 5 | 0.943 / .225 / 8.3 | 0.943 / .150 / 13.3 |
| hybrid | R2 gpt-4.1-mini* | 30 | 0.931 / .345 / 5 | 0.966 / .233 / 8.3 | 0.966 / .157 / 13.3 |
| cosine | R0 | – | 0.816 / .310 / 5 | 0.885 / .222 / 8.3 | 0.920 / .143 / 13.3 (K15 .954/25) |
| cosine | R3 | 30 | 0.908 / .362 / 5 | 0.943 / .245 / 8.3 | 0.943 / .157 / 13.3 |
| cosine | R3c | 30 | 0.931 / .343 / 5.7 | 0.954 / .231 / 9.4 | 0.977 / .147 / 14.9 |
| cosine | R2 gpt-4o-mini | 30 / 50 | 0.851 / 0.839 | 0.885 / 0.851 | 0.920 / 0.874 |

\* gpt-4.1-mini returned 29 scores for 30 passages in 113 of 170 calls. LlmReranker then **silently falls back to the stage-1 order**,
so this row is mostly R0, not the model's judgement. gpt-4o-mini fell back in 14 of 170 calls at K1=30 and **92 of 170 at K1=50**: it miscounts long arrays.

R3 score thresholds. Picked from the relevance_score distribution: relevant p50 0.188 / p25 0.096; non-relevant p50 0.044 / p90 0.155.
- Hybrid K1=30, plain threshold ≥ 0.03 / 0.05 / 0.1: 0.95/.24/17.8 ; 0.87/.38/9.4 ; 0.74/.63/3.7. Thresholds are poorly calibrated per query.
- Top-3, then add up to 8 while score ≥ t (t = 0.03 / 0.05 / 0.1): 0.94/.24/10 ; 0.94/.29/8 ; 0.93/.35/5.9.
- Pure thresholds lose recall. Top-k is safer.

## Single vs multi-step (hybrid, k2=5)
- Single-step: R0 0.986 → R3 0.973 → R2-4o 0.986.
- Multi-step: R0 0.714 → R3 0.714 → **R3c 1.000** (16.1 tools on multi rows) → R2-4o 0.643.
- The multi-step drop is the main weakness of top-k. Splitting the query on ` and ` / `, then ` / ` і ` / `, потім `
  and taking the union of per-clause top-k fixes it.
- Non-ASCII (secondary): R0 K5 0.692 → **R3 K5 0.962** → R3c 0.962. Cohere is multilingual; the BM25 part of the hub's hybrid scoring is not.

## Latency and cost per query (developer role: reader + writer calls, sequential)
- Stage 1: in-process scoring p50 1.7 ms, plus query embedding (≈260 ms p50 in the previous spike).
- R3 Cohere: K1=30 per query p50 383 / p95 801 ms (per call 197 / 285 ms); K1=50 p50 543 / p95 637 ms.
  Each clause in R3c adds one call per collection; these can run in parallel.
- R2 gpt-4o-mini: K1=30 p50 3.4 s / p95 4.6 s, **6,158 prompt tokens per query** (3,386 for Reader); K1=50 p50 4.2 s, **9,873 tokens**.
  So R2 costs more tokens than it saves: 6.2k spent against at most ~4k saved.

## Fixed / broken vs R0 (developer role, hybrid; K1=30, k=5)
- **R3 fixes:**
  - transports: "Add class ZCL_DEMO to transport"
  - UA create domain
  - UA "create class, add method, activate"
  - "CDS view + service binding"
  - UA dump→program
  - UA mask search + show code
- **R3 at k=3 also fixes:** "Remove class from transport", "Read BAPI_USER_GET_DETAIL and update its doc comment".
- **R3c also fixes:** "Find where-used of table … and show source", "Create class ZCL_DEMO_TEST … add to transport".
- **R3 breaks:**
  - "Where is function module BAPI_USER_GET_DETAIL used?" — Cohere ranks GetWhereUsed below the FM tools. This is the only R3c break against R0 K15.
  - "Read class ZCL_DEMO, add a method and activate" — plain R3 k5 only. R3c recovers it.
- *_TEST objects vs unit-test tools: no R3 regressions. The unit-carrier set stays 1.000 everywhere.
- **R2 gpt-4o-mini breaks:**
  - "Run the unit tests of ZCL_DEMO_TEST and show the results" — it picked GetUnitTestResult/Create* over the Run tool.
  - "Remove class ZCL_DEMO from transport" — it picked Delete* tools.
- Dumps: no change with either reranker in English.

## Recommendation
Add a reranker to the hub, but **only a dedicated cross-encoder (Cohere Rerank on AI Core)**. Do not use LlmReranker:
it is no better than R0, costs 6–10k prompt tokens and 3–4 s per query, and falls back silently on array-length mismatches.
That silent fallback is a correctness bug worth an upstream issue in llm-agent-libs.

Proposed configuration:
- Stage 1: hybrid, K1=30 per collection. K1=50 adds nothing.
- Stage 2: Cohere, top-k2=5 per collection.
- Plus a clause split with union for multi-step queries (R3c).

Expected effect against production K15:
- Same EN required-recall (0.977) with 9.4 instead of 25 tools on average. That is ≈15.6 × 260 ≈ **4.0k prompt tokens saved per request**.
- Non-ASCII queries: 0.885 → 0.962.
- Cost: +0.4–0.8 s latency per request.

Known gap: BAPI where-used. Fix it in GetWhereUsed's description or intents, not in the reranker.
Follow-ups: cache rerank results per query, and use a timeout-free fallback to the stage-1 order on a Cohere error.
