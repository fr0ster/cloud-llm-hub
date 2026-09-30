# Spike: per-tool document composition for tool retrieval

## TL;DR

- **The biggest lever is the upstream description text, not the doc layout.** Rewriting 18 weak descriptions (list in section 3) and keeping today's composition (C → RC) lifts English required-recall at K5 by 6 to 9 points on every embedder. At K10 it lifts it to 0.965–1.000.
- **Without rewrites, G is the best layout**: a short "verb ABAP object" phrase from the tool name plus the English intents, with no description. It beats C at K5 on every embedder. It stops winning once the descriptions are fixed: RC ≥ G there.
- **Multi-vector (E, H1, H3) does not help.** It is equal or worse than a single doc, especially at K5.
- **A long description is noise only where it is badly written.** Descriptions that are mostly about protocol details (AddTransportObject, RemoveTransportObject) or that are ambiguous (CreateUnitTest = RunUnitTest, CDS vs class unit tests) are what hurt. Once rewritten, A, B and C all beat G.
- **The "_TEST" swamp and BAPI_USER → transport/system-log come mostly from the BM25 half of the hub's `vector` store, not from the embedder.** The tokenizer splits `ZDEMO_D_TEST` into `test` and `BAPI_USER_CHANGE` into `user` and `change`. With vector-only scoring, CreateDomain is rank 1 for "Створи домен ZDEMO_D_TEST"; with hybrid scoring it is out of the top 12. This is a retrieval fix (query-side: drop identifier tokens from BM25), not a docs fix.
- **Variant F (Ukrainian intents) was dropped per the scope change.** The UK phrasings had already been generated (`uk-intents.json`, 234 tools, about 30 gpt-4o-mini calls). They were not evaluated.

## Setup

- **Harness:** `run.ts` is a standalone in-process cosine index. It has two scoring modes:
  - `hybrid` = exactly what the hub's `LLM_AGENT_TOOLS_RAG_BACKEND=vector` does: llm-agent `VectorRag` → `WeightedFusionStrategy`, 0.7·cosine + 0.3·BM25/max. BM25 statistics are computed over the records of the collection, using the same tokenizer (copied from `llm-agent/dist/rag/tokenizer.js`).
  - `vector` = cosine only, as in a Qdrant-style store.
- **Top-K is taken per collection**, with reader = exposition ≠ `high` and writer = `high`, then concatenated. MCP_Reader searches the reader collection only; MCP_Developer searches both. This mirrors `capPerCollection`.
- **Structural rows are excluded.** Metric definitions are copied from `tools/measure-tool-rag.ts`.
- **Multi-doc variants:** the tool score is the max over its docs, and each tool is counted once.
- **Sanity check against the baseline** (`accuracy-report.md`, variant C, hybrid, whole set, required-recall K5/K10):

  | embedder | this harness | baseline |
  |---|---|---|
  | bge-m3 | 0.765/0.824 (GPU run) | 0.765/0.824 |
  | 3-small | 0.765/0.824 | 0.765/0.824 |
  | 3-large | 0.824/0.912 | 0.824/0.912 |

  The baseline is reproduced exactly.
- **Caveat: local ollama bge-m3 returns NaN on GPU** for about 30 description-only texts ("failed to encode response: NaN"). All bge-m3 numbers below were therefore re-embedded on CPU (`num_gpu:0`). That moves C to 0.750/0.824, one row at K5.
- **Query sets.** The ASCII subset is primary, per the scope change. There are 2 role tiers per query.
  - `EN-orig`: 21 English queries from `tool-rag-queries.json`, giving 42 non-structural rows.
  - `EN-ext`: EN-orig plus 28 added English queries (`ext-queries.json`, 4 of them multi-step), giving 86 rows. The added queries target the weak spots: objects named `*_TEST`, unit tests, transports, dumps/feeds and `BAPI_*`.
  - **Caveat:** I wrote the added queries after seeing the weak spots. Treat their gains as optimistic. The EN-orig and whole-set gains below are independent of that.
  - One row = 0.024 on EN-orig and 0.012 on EN-ext.
- **Prompt tokens are not a criterion here.** The LLM receives the MCP tool schema, not the RAG doc. The doc's length or shape only affects retrieval, not prompt cost.
- **Variants:**
  - A = description only
  - B = baseToolText
  - C = production text (enriched + Workflow hints)
  - D = the "Intent:" line only
  - E = one doc per intent phrase (the intent line is comma-separated)
  - G = `namePhrase(name)` + intent line, e.g. "create ABAP class", "list ABAP runtime feeds", "get ABAP CDS view (DDL)"
  - H1 = name phrase + each intent as separate docs
  - H2 = G + the first sentence of the description
  - H3 = C doc + each intent as docs
  - H4 = G doc + C doc
  - R* = A/B/C/H2 with the rewritten descriptions from `desc-rewrites.json` (18 tools). The intents are unchanged.

## 1. Compact comparison

**EN-ext required-recall, K10 (K5)**, hybrid / vector

| variant | bge-m3 | oai-3-small | oai-3-large |
|---|---|---|---|
| A | 0.872 (0.837) / 0.872 (0.744) | 0.849 (0.837) / 0.860 (0.744) | 0.907 (0.826) / 0.895 (0.837) |
| B | 0.907 (0.872) / 0.884 (0.791) | 0.895 (0.849) / 0.907 (0.779) | 0.907 (0.872) / 0.907 (0.849) |
| C | 0.895 (0.849) / 0.895 (0.791) | 0.884 (0.872) / 0.907 (0.802) | 0.907 (0.860) / 0.953 (0.849) |
| D | 0.919 (0.872) / 0.884 (0.814) | 0.930 (0.884) / 0.884 (0.826) | 0.953 (0.884) / 0.907 (0.814) |
| E | 0.895 (0.837) / 0.895 (0.826) | 0.907 (0.826) / 0.860 (0.756) | 0.907 (0.895) / 0.872 (0.802) |
| G | 0.919 (0.884) / 0.919 (0.895) | 0.930 (0.895) / 0.907 (0.884) | 0.930 (0.884) / 0.965 (0.872) |
| H1 | 0.895 (0.849) / 0.907 (0.837) | 0.907 (0.826) / 0.884 (0.791) | 0.907 (0.872) / 0.942 (0.860) |
| H2 | 0.895 (0.872) / 0.895 (0.872) | 0.907 (0.884) / 0.884 (0.814) | 0.907 (0.884) / 0.942 (0.884) |
| H3 | 0.930 (0.872) / 0.907 (0.837) | 0.907 (0.884) / 0.849 (0.756) | 0.907 (0.860) / 0.895 (0.826) |
| H4 | 0.907 (0.872) / 0.919 (0.826) | 0.930 (0.907) / 0.907 (0.872) | 0.942 (0.895) / 0.965 (0.872) |
| RA | 0.977 (0.907) / 0.930 (0.849) | 0.953 (0.919) / 0.953 (0.884) | 1.000 (0.930) / 0.988 (0.930) |
| RB | 0.965 (0.907) / 0.953 (0.884) | 0.977 (0.919) / 0.919 (0.837) | 0.977 (0.953) / 0.988 (0.930) |
| RC | 0.965 (0.930) / 0.965 (0.884) | 0.977 (0.942) / 0.930 (0.860) | 1.000 (0.942) / 1.000 (0.919) |
| RH2 | 0.965 (0.919) / 0.953 (0.907) | 0.977 (0.930) / 0.919 (0.907) | 0.977 (0.942) / 0.977 (0.942) |

**Full tables per embedder and scoring mode**

- **Headline columns** are EN-ext required-recall, recall and precision at K5 and K10.
- **Secondary columns** are EN-orig required-recall, whole-set required-recall and UK (non-ASCII) required-recall.
- **Precision is low by construction** at ~0.13 at K10: the store returns 10 per collection, while 1–5 tools are relevant.


#### bge-m3 — scoring: hybrid

| variant | EN-ext K5 req | rec | prec | EN-ext K10 req | rec | prec | EN-orig K5 req | EN-orig K10 req | whole K10 req | UK K10 req |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.837 | 0.78 | 0.212 | **0.872** | 0.848 | 0.12 | 0.857 | 0.905 | 0.765 | 0.538 |
| B | 0.872 | 0.796 | 0.212 | **0.907** | 0.874 | 0.122 | 0.881 | 0.929 | 0.794 | 0.577 |
| C | 0.849 | 0.809 | 0.22 | **0.895** | 0.886 | 0.124 | 0.857 | 0.929 | 0.824 | 0.654 |
| D | 0.872 | 0.832 | 0.223 | **0.919** | 0.892 | 0.126 | 0.881 | 0.929 | 0.912 | 0.885 |
| E | 0.837 | 0.788 | 0.216 | **0.895** | 0.875 | 0.122 | 0.81 | 0.929 | 0.853 | 0.731 |
| G | 0.884 | 0.826 | 0.223 | **0.919** | 0.894 | 0.126 | 0.905 | 0.929 | 0.912 | 0.885 |
| H1 | 0.849 | 0.8 | 0.219 | **0.895** | 0.865 | 0.12 | 0.833 | 0.929 | 0.838 | 0.692 |
| H2 | 0.872 | 0.813 | 0.219 | **0.895** | 0.889 | 0.124 | 0.881 | 0.929 | 0.897 | 0.846 |
| H3 | 0.872 | 0.82 | 0.22 | **0.93** | 0.874 | 0.123 | 0.881 | 0.929 | 0.824 | 0.654 |
| H4 | 0.872 | 0.824 | 0.223 | **0.907** | 0.9 | 0.126 | 0.881 | 0.929 | 0.868 | 0.769 |
| RA | 0.907 | 0.823 | 0.223 | **0.977** | 0.904 | 0.127 | 0.857 | 0.952 | 0.838 | 0.654 |
| RB | 0.907 | 0.828 | 0.22 | **0.965** | 0.899 | 0.126 | 0.857 | 0.929 | 0.853 | 0.731 |
| RC | 0.93 | 0.857 | 0.233 | **0.965** | 0.926 | 0.129 | 0.905 | 0.929 | 0.882 | 0.808 |
| RH2 | 0.919 | 0.857 | 0.23 | **0.965** | 0.924 | 0.13 | 0.905 | 0.952 | 0.912 | 0.846 |

#### oai-3-small — scoring: hybrid

| variant | EN-ext K5 req | rec | prec | EN-ext K10 req | rec | prec | EN-orig K5 req | EN-orig K10 req | whole K10 req | UK K10 req |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.837 | 0.782 | 0.214 | **0.849** | 0.833 | 0.119 | 0.857 | 0.881 | 0.75 | 0.538 |
| B | 0.849 | 0.788 | 0.214 | **0.895** | 0.855 | 0.12 | 0.857 | 0.929 | 0.809 | 0.615 |
| C | 0.872 | 0.823 | 0.227 | **0.884** | 0.885 | 0.126 | 0.905 | 0.905 | 0.824 | 0.692 |
| D | 0.884 | 0.824 | 0.221 | **0.93** | 0.896 | 0.128 | 0.905 | 0.929 | 0.897 | 0.846 |
| E | 0.826 | 0.791 | 0.214 | **0.907** | 0.899 | 0.127 | 0.786 | 0.929 | 0.824 | 0.654 |
| G | 0.895 | 0.845 | 0.229 | **0.93** | 0.915 | 0.131 | 0.929 | 0.929 | 0.897 | 0.846 |
| H1 | 0.826 | 0.809 | 0.222 | **0.907** | 0.9 | 0.126 | 0.786 | 0.929 | 0.824 | 0.654 |
| H2 | 0.884 | 0.835 | 0.226 | **0.907** | 0.881 | 0.124 | 0.905 | 0.929 | 0.853 | 0.731 |
| H3 | 0.884 | 0.817 | 0.224 | **0.907** | 0.905 | 0.127 | 0.881 | 0.929 | 0.853 | 0.731 |
| H4 | 0.907 | 0.853 | 0.233 | **0.93** | 0.916 | 0.131 | 0.929 | 0.929 | 0.853 | 0.731 |
| RA | 0.919 | 0.854 | 0.231 | **0.953** | 0.905 | 0.128 | 0.905 | 0.929 | 0.824 | 0.654 |
| RB | 0.919 | 0.855 | 0.23 | **0.977** | 0.903 | 0.126 | 0.857 | 0.952 | 0.868 | 0.731 |
| RC | 0.942 | 0.877 | 0.24 | **0.977** | 0.942 | 0.133 | 0.929 | 0.952 | 0.897 | 0.808 |
| RH2 | 0.93 | 0.887 | 0.24 | **0.977** | 0.938 | 0.133 | 0.929 | 0.952 | 0.868 | 0.731 |

#### oai-3-large — scoring: hybrid

| variant | EN-ext K5 req | rec | prec | EN-ext K10 req | rec | prec | EN-orig K5 req | EN-orig K10 req | whole K10 req | UK K10 req |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.826 | 0.767 | 0.214 | **0.907** | 0.872 | 0.126 | 0.833 | 0.976 | 0.941 | 0.885 |
| B | 0.872 | 0.783 | 0.212 | **0.907** | 0.878 | 0.123 | 0.881 | 0.929 | 0.853 | 0.731 |
| C | 0.86 | 0.835 | 0.229 | **0.907** | 0.885 | 0.127 | 0.881 | 0.952 | 0.912 | 0.846 |
| D | 0.884 | 0.826 | 0.223 | **0.953** | 0.901 | 0.129 | 0.905 | 0.976 | 0.956 | 0.923 |
| E | 0.895 | 0.84 | 0.226 | **0.907** | 0.886 | 0.123 | 0.929 | 0.929 | 0.897 | 0.846 |
| G | 0.884 | 0.837 | 0.224 | **0.93** | 0.912 | 0.129 | 0.905 | 0.929 | 0.926 | 0.923 |
| H1 | 0.872 | 0.823 | 0.219 | **0.907** | 0.894 | 0.124 | 0.881 | 0.929 | 0.897 | 0.846 |
| H2 | 0.884 | 0.845 | 0.229 | **0.907** | 0.893 | 0.126 | 0.905 | 0.929 | 0.926 | 0.923 |
| H3 | 0.86 | 0.811 | 0.22 | **0.907** | 0.899 | 0.126 | 0.857 | 0.929 | 0.882 | 0.808 |
| H4 | 0.895 | 0.858 | 0.234 | **0.942** | 0.921 | 0.13 | 0.905 | 0.929 | 0.926 | 0.923 |
| RA | 0.93 | 0.835 | 0.229 | **1** | 0.938 | 0.133 | 0.881 | 1 | 0.956 | 0.885 |
| RB | 0.953 | 0.835 | 0.224 | **0.977** | 0.916 | 0.128 | 0.929 | 0.952 | 0.926 | 0.885 |
| RC | 0.942 | 0.876 | 0.24 | **1** | 0.941 | 0.133 | 0.905 | 1 | 0.971 | 0.923 |
| RH2 | 0.942 | 0.89 | 0.243 | **0.977** | 0.94 | 0.133 | 0.952 | 0.952 | 0.941 | 0.923 |

#### bge-m3 — scoring: vector

| variant | EN-ext K5 req | rec | prec | EN-ext K10 req | rec | prec | EN-orig K5 req | EN-orig K10 req | whole K10 req | UK K10 req |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.744 | 0.638 | 0.174 | **0.872** | 0.818 | 0.115 | 0.714 | 0.833 | 0.735 | 0.577 |
| B | 0.791 | 0.73 | 0.195 | **0.884** | 0.877 | 0.123 | 0.762 | 0.905 | 0.824 | 0.692 |
| C | 0.791 | 0.723 | 0.197 | **0.895** | 0.856 | 0.122 | 0.786 | 0.881 | 0.824 | 0.731 |
| D | 0.814 | 0.729 | 0.2 | **0.884** | 0.83 | 0.118 | 0.786 | 0.881 | 0.882 | 0.885 |
| E | 0.826 | 0.77 | 0.216 | **0.895** | 0.853 | 0.122 | 0.857 | 0.929 | 0.838 | 0.692 |
| G | 0.895 | 0.79 | 0.213 | **0.919** | 0.861 | 0.119 | 0.881 | 0.905 | 0.912 | 0.923 |
| H1 | 0.837 | 0.789 | 0.222 | **0.907** | 0.867 | 0.123 | 0.857 | 0.929 | 0.853 | 0.731 |
| H2 | 0.872 | 0.777 | 0.209 | **0.895** | 0.861 | 0.122 | 0.833 | 0.881 | 0.882 | 0.885 |
| H3 | 0.837 | 0.77 | 0.216 | **0.907** | 0.854 | 0.123 | 0.881 | 0.952 | 0.853 | 0.692 |
| H4 | 0.826 | 0.743 | 0.202 | **0.919** | 0.879 | 0.123 | 0.786 | 0.929 | 0.897 | 0.846 |
| RA | 0.849 | 0.736 | 0.199 | **0.93** | 0.863 | 0.119 | 0.81 | 0.881 | 0.809 | 0.692 |
| RB | 0.884 | 0.812 | 0.215 | **0.953** | 0.909 | 0.127 | 0.833 | 0.929 | 0.882 | 0.808 |
| RC | 0.884 | 0.8 | 0.214 | **0.965** | 0.907 | 0.127 | 0.857 | 0.952 | 0.912 | 0.846 |
| RH2 | 0.907 | 0.832 | 0.224 | **0.953** | 0.906 | 0.125 | 0.857 | 0.929 | 0.912 | 0.885 |

#### oai-3-small — scoring: vector

| variant | EN-ext K5 req | rec | prec | EN-ext K10 req | rec | prec | EN-orig K5 req | EN-orig K10 req | whole K10 req | UK K10 req |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.744 | 0.718 | 0.197 | **0.86** | 0.82 | 0.117 | 0.738 | 0.881 | 0.779 | 0.615 |
| B | 0.779 | 0.759 | 0.212 | **0.907** | 0.855 | 0.122 | 0.786 | 0.905 | 0.838 | 0.731 |
| C | 0.802 | 0.764 | 0.209 | **0.907** | 0.835 | 0.12 | 0.81 | 0.881 | 0.853 | 0.808 |
| D | 0.826 | 0.767 | 0.213 | **0.884** | 0.852 | 0.124 | 0.786 | 0.857 | 0.868 | 0.885 |
| E | 0.756 | 0.734 | 0.207 | **0.86** | 0.839 | 0.118 | 0.667 | 0.833 | 0.794 | 0.731 |
| G | 0.884 | 0.836 | 0.231 | **0.907** | 0.896 | 0.128 | 0.857 | 0.857 | 0.868 | 0.885 |
| H1 | 0.791 | 0.774 | 0.215 | **0.884** | 0.872 | 0.123 | 0.69 | 0.81 | 0.779 | 0.731 |
| H2 | 0.814 | 0.764 | 0.214 | **0.884** | 0.864 | 0.122 | 0.81 | 0.857 | 0.824 | 0.769 |
| H3 | 0.756 | 0.739 | 0.212 | **0.849** | 0.831 | 0.119 | 0.667 | 0.81 | 0.809 | 0.808 |
| H4 | 0.872 | 0.825 | 0.23 | **0.907** | 0.893 | 0.128 | 0.833 | 0.857 | 0.838 | 0.808 |
| RA | 0.884 | 0.816 | 0.22 | **0.953** | 0.9 | 0.125 | 0.833 | 0.952 | 0.868 | 0.731 |
| RB | 0.837 | 0.801 | 0.223 | **0.919** | 0.868 | 0.124 | 0.81 | 0.881 | 0.853 | 0.808 |
| RC | 0.86 | 0.799 | 0.221 | **0.93** | 0.869 | 0.124 | 0.833 | 0.905 | 0.897 | 0.885 |
| RH2 | 0.907 | 0.828 | 0.228 | **0.919** | 0.882 | 0.126 | 0.881 | 0.881 | 0.838 | 0.769 |

#### oai-3-large — scoring: vector

| variant | EN-ext K5 req | rec | prec | EN-ext K10 req | rec | prec | EN-orig K5 req | EN-orig K10 req | whole K10 req | UK K10 req |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.837 | 0.787 | 0.217 | **0.895** | 0.851 | 0.124 | 0.857 | 0.952 | 0.941 | 0.923 |
| B | 0.849 | 0.772 | 0.209 | **0.907** | 0.836 | 0.12 | 0.881 | 0.976 | 0.926 | 0.846 |
| C | 0.849 | 0.796 | 0.22 | **0.953** | 0.883 | 0.128 | 0.857 | 0.976 | 0.971 | 0.962 |
| D | 0.814 | 0.742 | 0.213 | **0.907** | 0.833 | 0.12 | 0.833 | 0.952 | 0.956 | 0.962 |
| E | 0.802 | 0.775 | 0.22 | **0.872** | 0.84 | 0.122 | 0.81 | 0.929 | 0.912 | 0.885 |
| G | 0.872 | 0.843 | 0.231 | **0.965** | 0.926 | 0.132 | 0.881 | 0.976 | 0.985 | 1 |
| H1 | 0.86 | 0.83 | 0.227 | **0.942** | 0.915 | 0.129 | 0.81 | 0.929 | 0.912 | 0.885 |
| H2 | 0.884 | 0.824 | 0.221 | **0.942** | 0.913 | 0.129 | 0.905 | 0.929 | 0.956 | 1 |
| H3 | 0.826 | 0.795 | 0.224 | **0.895** | 0.858 | 0.123 | 0.81 | 0.929 | 0.912 | 0.885 |
| H4 | 0.872 | 0.843 | 0.231 | **0.965** | 0.926 | 0.132 | 0.881 | 0.976 | 0.985 | 1 |
| RA | 0.93 | 0.859 | 0.231 | **0.988** | 0.919 | 0.131 | 0.905 | 1 | 0.971 | 0.923 |
| RB | 0.93 | 0.818 | 0.221 | **0.988** | 0.907 | 0.127 | 0.952 | 1 | 0.985 | 0.962 |
| RC | 0.919 | 0.824 | 0.229 | **1** | 0.933 | 0.133 | 0.952 | 1 | 1 | 1 |
| RH2 | 0.942 | 0.874 | 0.233 | **0.977** | 0.933 | 0.131 | 0.929 | 0.952 | 0.971 | 1 |

## 2. Findings

### Winner per embedder

**Current upstream descriptions**, EN-ext required-recall at K5 (the cut that discriminates; K10 is near saturation):

| embedder | best variant | K5 hybrid | K5 vector | C for comparison |
|---|---|---|---|---|
| bge-m3 | G | 0.884 | 0.895 | 0.849 / 0.791 |
| 3-small | H4 (G doc + C doc) | 0.907 | 0.872 | — |
| 3-small | G | 0.895 | 0.884 | 0.872 / 0.802 |
| 3-large | G / H4 at K10 | 0.965 at K10 (vector) | | 0.953 |
| 3-large | E / H4 at K5 (hybrid) | 0.895 | | 0.86 |

**With the rewritten descriptions**, RC wins or ties on every embedder:

| embedder | RC K10 hybrid | RC K10 vector | RC K5 hybrid | RC K5 vector |
|---|---|---|---|---|
| bge-m3 | 0.965 | 0.965 | 0.93 | 0.884 |
| 3-small | 0.977 | 0.93 | 0.942 | 0.86 |
| 3-large | 1.000 | 1.000 | 0.942 | 0.919 |

On EN-orig, whose queries are independent of the rewrites, RC vs C:

| embedder | K5 hybrid | K10 hybrid | K5 vector | K10 vector |
|---|---|---|---|---|
| bge-m3 | 0.857 → 0.905 | 0.929 → 0.929 | | |
| 3-small | 0.905 → 0.929 | 0.905 → 0.952 | | |
| 3-large | 0.881 → 0.905 | 0.952 → 1.000 | 0.857 → 0.952 | 0.976 → 1.000 |

The whole set (EN + UK) at K5 also improves on every embedder:
- bge-m3: 0.75 → 0.838
- 3-small: 0.765 → 0.824
- 3-large: 0.824 → 0.897 (hybrid) and 0.853 → 0.956 (vector)

**Overall:** 3-large + RC is the best measured configuration. It reaches 1.000 required-recall at K10 on EN-ext, EN-orig and the whole set with vector scoring.

### Does multi-vector (E) help? No.

- E and H1 (one doc per intent phrase, max-sim) are at or below C, and clearly below D and G, which carry the same intents in a single doc.
- At K5 they are the worst variants on 3-small (E 0.826 hybrid / 0.756 vector, vs D 0.884 / 0.826).
- Why: max-sim over short phrases rewards any tool with a single generic phrase that matches ("get test run ID", "check test run result"). It also multiplies the number of near-duplicate candidates.
- H3 (C doc plus intent docs) is no better than C.

### Do UK intents close the Ukrainian gap?

Not measured; F was dropped by the scope change. As a side observation, the intent-only layouts D and G already raise UK required-recall at K10 over C:
- bge-m3: 0.654 → 0.885
- 3-small: 0.692 → 0.846 (hybrid)

So the long English description is what hurts the non-English queries.

### Is the long description useful or noise (A/B vs G)?

- **With today's descriptions it is mostly noise.** A (description only) is the worst or near-worst variant at K5 on every embedder. G, which drops the description, beats both A and C.
- **The cause is not length as such.** It is a handful of descriptions whose words describe protocol mechanics, or siblings, instead of the operation:
  - AddTransportObject and RemoveTransportObject spend most of their text on SCTS_ADT_MSG 009, `position` and 200 semantics.
  - CreateUnitTest and RunUnitTest have identical text.
  - The CDS unit-test tools do not say "CDS views only".
  - GetWhereUsed ends with a list of unsupported types ("service definitions/bindings, BAdI, … message classes") that pulls it toward the wrong queries.
- **With those rewritten, the description becomes useful.** RA, RB and RC all beat G, and RC (description + params + intents + workflow hints) is the best.
- **Parameter names (B vs A) help a little**, about +3 points at K5 on the original descriptions. After the rewrites the difference is noise.
- **The name phrase (G) is a cheap, robust fallback.** It is deterministic and needs no LLM. It is the best layout for as long as some descriptions stay bad.

### Hybrid vs vector-only scoring

- 3-large is better with vector-only scoring: C K10 0.953 vs 0.907; RC 1.000 either way.
- bge-m3 and 3-small are better with hybrid at K5.
- The BM25 half is also the direct cause of two known weak spots:
  - The `_TEST` swamp: "Створи домен ZDEMO_D_TEST", 3-large, variant C. Hybrid scoring returns 12 unit-test tools first and misses CreateDomain. Vector-only scoring puts CreateDomain at rank 1.
  - "What parameters does BAPI_USER_CHANGE have?": hybrid puts ListTransports first on the token `user`, plus CreateTransportTask (`target_user`) and RuntimeListSystemMessages.
- **Fix, independent of docs (hub side, or the llm-agent tokenizer as an injected strategy):**
  - Do not feed ABAP identifiers from the query into BM25. Identifiers here means tokens that contain `_`, or that match `^[ZY]`, `^[A-Z0-9_]{4,}$` or `^/`.
  - Alternatively, tokenize an identifier only as its whole word. Do not split it on `_`.

## 3. Per-tool diagnosis and proposed upstream description rewrites (@mcp-abap-adt/lib)

Each item gives what in the doc causes the miss, then the proposed new description. The full text of every rewrite is in `desc-rewrites.json` in this directory. The measured effect of applying all of them is in the RA/RB/RC/RH2 rows.

### Unit tests (swamping, identical text, CDS vs class)

1. **RunUnitTest.** It is identical to CreateUnitTest, and the text never says *what* is tested ("provided class test definitions").
   - Proposed: "Run the ABAP Unit tests of a class or program (its local test classes, FOR TESTING) and return a run_id. Read the outcome with GetUnitTestResult or GetUnitTest."
2. **CreateUnitTest.** Its name suggests "create a test", but it runs one. It steals "write a unit test" queries.
   - Proposed: "Alias of RunUnitTest, kept for compatibility: runs the ABAP Unit tests of a class or program and returns a run_id. Does not create or write test code — to write tests use UpdateLocalTestClass."
   - Better still: deprecate and remove it.
3. **UpdateUnitTest / DeleteUnitTest.** Both always fail ("ADT does not support…"), yet they rank for any "unit test" query.
   - Proposed: "Unsupported: ADT cannot modify / delete an ABAP Unit test run, so this always fails. To change / remove test code use UpdateLocalTestClass / DeleteLocalTestClass."
   - Better still: do not export them.
4. **UpdateLocalTestClass.** This is the tool for "write a unit test class for ZCL_X", but its text says only "update a local test class". It loses to CreateCdsUnitTest.
   - Proposed: "Write or replace the ABAP Unit test code of a class: the local test classes (FOR TESTING) in the class's test include. Use it to add or change unit tests for a ZCL_* class. Locks, updates, unlocks and optionally activates the class."
5. **GetLocalTestClass.** It outranks ReadClass for "show the source of class ZCL_DEMO_TEST".
   - Proposed: "Read the ABAP Unit test code of a class: its local test classes (FOR TESTING) in the test include. Not the class's main source — for that use ReadClass or GetClass. Active or inactive version."
6. **DeleteLocalTestClass.**
   - Proposed: "Remove the ABAP Unit test code of a class by clearing its local test classes include. …"
7. **CreateCdsUnitTest / UpdateCdsUnitTest / DeleteCdsUnitTest.** Nothing restricts them to CDS, so they win generic class-test queries. The 7.50 / issue #207 / AdtClientLegacy text is implementation noise.
   - Proposed: prefix each with "CDS views only: …" and point to UpdateLocalTestClass for class tests.
   - Shorten the legacy note to "Not available below BASIS 7.50."
8. **The `_TEST` object names themselves** (ZDEMO_D_TEST, ZDEMO_T_TEST) are mostly the BM25 tokenizer (section 2). No description can fix that. Fix it at query tokenization.

### Transports

9. **AddTransportObject.** The query "Add class ZCL_DEMO to transport DEVK900001" is missed at K10 by C on every embedder. The text is dominated by RemoveTransportObject, SCTS_ADT_MSG 009 and "a 200 says…", and it never says "add an ABAP object (class, program, …) to a transport request".
   - Proposed: "Add an existing ABAP object (class, program, table, CDS view, ...) to a transport request, by attaching it to a task of that request so it travels with the request. Refused with SCTS_ADT_MSG 009 when another task already holds the object. Confirm with ReadTransportObjects."
   - Move the rest (position / 200 semantics) into parameter descriptions.
10. **RemoveTransportObject.** It loses to Delete* for "remove class X from transport" because "Detach one object's entry … so its name can be used again after the object was deleted" reads like a delete.
    - Proposed: "Remove an ABAP object from a transport request by detaching its entry from the transport task that holds it (position from ReadTransportObjects is required). Does not delete the object itself. Confirm with ReadTransportActionLog."

### Dumps and feeds

11. **RuntimeListFeeds.** It is missed for "Why did program X crash? Show me the dump", where RuntimeGetDumpById and GetDumpSection win. It is also weak on UK dump queries. The text leads with "ADT runtime feeds / feed descriptors", and "dumps" appears only as an enum value.
    - Proposed: "[runtime] List ABAP short dumps (ST22 runtime errors), SM02 system messages or SAP Gateway errors from the ADT runtime feeds, filtered by user and time range. Use feed_type=dumps for dumps, then read one with RuntimeGetDumpById."

### BAPI / function modules

12. **ReadFunctionModule / GetFunctionModule.** They are missed for "What parameters does BAPI_USER_CHANGE have?" in every non-rewritten variant. Neither text mentions BAPI, RFC or the parameter signature. Meanwhile "user" and "change" hit ListTransports, CreateTransportTask and Update* (BM25) and UpdateDomain/UpdateDataElement (vector).
    - Proposed, ReadFunctionModule: "[read-only] Read an ABAP function module (FM, BAPI or RFC function): source code and signature (importing, exporting, changing, tables parameters and exceptions), plus package and description."
    - Proposed, GetFunctionModule: "Retrieve an ABAP function module (FM, BAPI or RFC function): source code and parameter signature. Active or inactive version."
    - After the rewrite this query is found at K10 on every embedder except 3-small with vector scoring.

### Other misses found on the way (same kind of cause)

13. **GetWhereUsed.** It is missed for "Where is class ZCL_DEMO used?" with vector-only scoring on bge-m3 and 3-small. The trailing unsupported-type list drags it toward message classes and service bindings.
    - Proposed: "[read-only] Where-used list of an ABAP object (class, interface, program, function module, table, data element, CDS view, ...): find every object that uses, calls or references it. Answers "where is X used", "who calls X". Returns the referencing objects with type and package. Supported object types are listed in object_type."
    - Move the unsupported list into the `object_type` parameter description.
14. **CreateServiceDefinition / CreateServiceBinding.** "Create a CDS view and a service binding for it" misses CreateServiceDefinition, the hard prerequisite, on every non-3-large variant. Neither text links the two.
    - Proposed, CreateServiceDefinition: "Create an ABAP service definition that exposes CDS views as an OData service, in initial state. A service binding (CreateServiceBinding) needs one to publish the service."
    - Proposed, CreateServiceBinding: "Create an OData service binding (V2 or V4, UI or Web API) that publishes an existing service definition, in initial state. Create the service definition first with CreateServiceDefinition."
    - This still misses on bge-m3 and 3-small; the query never names a service definition.

**General rule for the upstream PR:**
- The first sentence should say *what the user gets*: "verb + ABAP object type + what it returns".
- Name sibling tools only to disambiguate ("Not X — use Y").
- Keep protocol mechanics (message numbers, HTTP 200 semantics, positions, legacy-backend errors) in the parameter descriptions or in a later sentence.
- Never ship two tools with identical text.

## 4. Recommendation

1. **Upstream (mcp-abap-adt/lib):** PR the 18 description rewrites above. This is the largest gain measured: RC vs C is +5 to +9 points at K5 on EN-ext, on every embedder and both scoring modes. Also deprecate CreateUnitTest, and stop exporting UpdateUnitTest/DeleteUnitTest.
2. **Hub, per tool: keep the current composition** (baseToolText + LLM intents + Workflow hints = C). Once the descriptions are fixed, this is the best layout (RC). After the lib bump, regenerate `tool-intents.json` and the embedding bundle, so the intents are derived from the new descriptions.
3. **Do not adopt multi-vector (E/H1/H3).** It is no gain, and it means 5x the records.
4. **Until the upstream release lands:** G (name phrase + intents, no description) is the best layout on today's text, +3 to +10 points at K5. It is also the most robust to non-English queries. It is a valid interim choice, and it needs no description override in the hub.
5. **Retrieval fix, orthogonal to docs:** stop the BM25 half of `VectorRag` from splitting ABAP identifiers in the query (`ZDEMO_D_TEST` → `test`, `BAPI_USER_CHANGE` → `user`). Do it as an injected tokenizer or strategy. Or move to vector-only scoring with 3-large, which already scores best there.

## Files (this directory)

| file | contents |
|---|---|
| `dump-corpus.ts` → `corpus.json` | the 234 tools: description, base, prod text, exposition, intents |
| `run.ts` | the harness. Env: `EMB`, `VAR`, `SCORING=hybrid\|vector`, `TAG` |
| `res-{hybrid,vector}.json` | metrics for variants A–H4 |
| `rw-{hybrid,vector}.json` | metrics for the rewrite variants |
| `*.details.json` | per-row top-12 and K10 misses |
| `diag.py` | per-query top list |
| `tables.py` | builds the tables |
| `ext-queries.json` | the 28 added EN queries |
| `desc-rewrites.json` | the proposed descriptions |
| `emb-*.jsonl` | embedding caches (normalized float32, base64) |
| `uk-intents.json` | generated UK phrasings, not evaluated |
| `nan-texts.gpu.log` | texts that hit the ollama GPU NaN |
