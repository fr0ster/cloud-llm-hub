# Tool corpus and the embedding bundle

## TL;DR

- The tool RAG is built **once** and shared by every destination: the tools come
  from `HandlerExporter` and are the same for every SAP system.
- Tool vectors are **built, never computed at startup**. The build step
  `tools/generate-tool-embeddings.ts` writes them; startup only loads them.
- Where the build step writes depends on `LLM_AGENT_TOOLS_RAG_BACKEND`:
  - `in-memory`: nothing to build (keyword-only).
  - `vector`: a bundle file per embedder fingerprint.
  - `qdrant`: two fixed role stores plus a catalog record each.
- Nothing matching at startup → `ToolCorpusMissingError` naming the build step.
- `tools/deploy.sh` always runs the build step, with the same `--mtaext` it deploys.

## How it loads at startup

- **Loaded once.** `ensureSharedToolsVectorized` (`srv/agent-manager.ts`, global
  single-flight) calls `loadToolCorpus`, and every destination agent points at
  the result. It never embeds and never calls an LLM.
- **Per backend:**

  | Tools backend | What startup loads | When it is not there |
  |---|---|---|
  | `in-memory` | the texts from `srv/tool-intents.json` | — |
  | `vector` | `srv/tool-embeddings[.<fp>].json` — the bundle for this embedder's fingerprint, only if the fingerprint **and every entry's text** match | `ToolCorpusMissingError` |
  | `qdrant` | the stores `<prefix>-tools-reader` and `<prefix>-tools-writer`, only if each role's record in `<prefix>-catalog` carries the current fingerprint and corpus hashes | `ToolCorpusMissingError` |

- **Bundle names.** The committed SAP AI Core bundle keeps the name
  `srv/tool-embeddings.json`. Any other embedder gets
  `srv/tool-embeddings.<fp>.json`: built per deployment, never committed
  (`.gitignore`).
- **What a missing corpus looks like.** The process keeps running, but no
  destination becomes ready: every SAP request answers `503` with the
  `ToolCorpusMissingError` message. Run the build step and restart.
- **Skills are not part of the corpus.** They are vectorized per process at
  agent build. On `qdrant` they go to a per-process side store; the Qdrant role
  stores receive no runtime writes.

## Regenerate

Run it after tools, `tool-intents.json` or the embedder change.

```bash
# 1. enrich every tool whose text is new or changed (needs an LLM)
npx tsx tools/generate-tool-intents.ts

# 2. build the tool vectors for the target configuration (needs the embedder)
npx tsx tools/generate-tool-embeddings.ts [--mtaext <file>]
```

- **Target configuration:** step 2 resolves it with the app's own rules:
  `.env`, then the `--mtaext` parameters (those win), then `default-env.json`.
- **What step 2 does per backend:**
  - `vector`: writes the bundle for the fingerprint. A matching bundle → exit 0,
    zero embedding calls.
  - `qdrant`: per role, a record with matching hashes → skipped. Otherwise the
    role store is **replaced in place**: old store and record deleted, current
    corpus written, point count verified, then the record written.
- **Credentials:** the embedder's, e.g. SAP AI Core via a bound `aicore`
  service in `default-env.json` or `AICORE_SERVICE_KEY`; `openai`/`ollama` via
  `LLM_AGENT_EMBEDDER_URL` and `LLM_AGENT_EMBEDDER_API_KEY`.
- **Order matters:** the embeddings generator stops if any tool is missing from
  `tool-intents.json`, so run step 1 first.
- **Deploys:** `tools/deploy.sh` runs step 2 with the same `--mtaext` it
  deploys, before `mbt build`.
- **Hand edits:** a `tool-intents.json` entry needs its `enriched` text. Do not
  write entries by hand; run the generator.

## Migration

**Before:** a deployment whose embedder the committed AI Core bundle did not
cover (for example an `openai` embedder) vectorized the tool corpus at runtime,
on first start.

**Now:** it must run the build step, or every SAP request answers `503`
(`ToolCorpusMissingError`).

- Deploying with `tools/deploy.sh`: nothing to do — it runs the build step.
- Deploying any other way: run
  `npx tsx tools/generate-tool-embeddings.ts --mtaext <file>` before `mbt build`.
- **Sharing one Qdrant between deployments:** give each its own
  `LLM_AGENT_QDRANT_PREFIX`. The role store names are fixed per prefix, so two
  deployments with one prefix replace each other's stores.
