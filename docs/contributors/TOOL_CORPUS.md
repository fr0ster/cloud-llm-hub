# Tool corpus and the embedding bundle

## TL;DR

- The tool RAG is built **once** and shared by every destination: the tools come
  from `HandlerExporter` and are the same for every SAP system.
- Two committed files feed it:
  - `srv/tool-intents.json` holds each tool's text plus an LLM-written *Intent* line.
  - `srv/tool-embeddings.json` holds the precomputed vectors of those texts.
- If the bundle matches the embedder, startup makes **zero** embedding calls.
- Regenerate both files after the tool set, a tool description or the embedder
  changes.

## How it loads at startup

- **Built once.** `ensureSharedToolsVectorized` (`srv/agent-manager.ts`, global
  single-flight) builds the store, and every destination agent points at it.
  Nothing is re-vectorized per destination.
- **Loaded from the bundle.** The shared store reads `srv/tool-embeddings.json`
  through `upsertPrecomputedRaw`. Which entries it reuses depends on:

  | Bundle vs runtime | Result |
  |---|---|
  | `embedderFingerprint` matches (provider, model, resource group) and each entry's text is identical | used as is, no embedding call |
  | fingerprint differs | the whole corpus is vectorized at runtime |
  | some tools missing or with changed text | only those are embedded |

## Regenerate

Run it after tools, `tool-intents.json` or the embedder change.

```bash
# 1. enrich every tool whose text is new or changed (needs an LLM)
npx tsx tools/generate-tool-intents.ts

# 2. embed the whole corpus into the bundle (needs the embedder)
npx tsx tools/generate-tool-embeddings.ts
```

- **Credentials:** both scripts need SAP AI Core credentials, either a bound
  `aicore` service in `default-env.json` or `AICORE_SERVICE_KEY`.
- **Order matters:** the embeddings generator stops if any tool is missing from
  `tool-intents.json`, so run step 1 first.
- **One bundle per embedder:** its fingerprint must match the target embedder.
  - One AI Core bundle covers every `sap-ai-sdk` deployment.
  - An `openai` deployment falls back to vectorizing at runtime. That is still
    one vectorization for the shared corpus, not one per destination.
- **Hand edits:** a `tool-intents.json` entry needs its `enriched` text. Do not
  write entries by hand; run the generator.
