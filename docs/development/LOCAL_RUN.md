# Running cloud-llm-hub locally

A BTP-free run: Ollama for the LLM and the embedder, a local Qdrant for tool
vectors, and a SAP destination supplied via an env variable instead of the
BTP Destination service (spec §5).

## TL;DR

```bash
cp .env.local.example .env        # then set the host, client and destination name
docker compose -f docker-compose.local.yml up -d
ollama pull qwen2.5:14b && ollama pull bge-m3
npm ci
npm run dev:local
```

- **One destination name, three places** — the `name` in `destinations`,
  `LLM_AGENT_MCP_DESTINATION`, and the `X-SAP-Destination` header.
- **Chat needs SAP credentials** once `LLM_AGENT_MCP_DESTINATION` is set.
  Want LLM-only chat? Leave it unset — see [Chat without SAP](#chat-without-sap-llm-only).
- **The chat model must be pulled** — whatever `LLM_AGENT_MODEL` names.

## Prerequisites

- **[Ollama](https://ollama.com)**, with a tool-calling model pulled
  (`qwen2.5:14b`) and an embedding model (`bge-m3`).
- **Docker**, for the local Qdrant container.
- **Node 22**.
- **A SAP system reachable from this machine** — on-premise via Cloud
  Connector, or a system with a public URL.
- **A package you own** in that system, for write tests. Never point write
  tests at a shared read-only package — create your own test package first.

## Steps

1. **Copy the env file:**

   ```bash
   cp .env.local.example .env
   ```

   Edit `.env`: set the `destinations` entry's `url` to your SAP system
   (e.g. `https://sap.example.com:44300`) and `sapClient` to its client
   (e.g. `100`).

   The destination name (`SAP_DEV` by default) must be **the same in three
   places**. Rename it in one, rename it in all:

   | Where | Example |
   |---|---|
   | `"name"` inside `destinations=[...]` | `"name":"SAP_DEV"` |
   | `LLM_AGENT_MCP_DESTINATION` | `LLM_AGENT_MCP_DESTINATION=SAP_DEV` |
   | `X-SAP-Destination` request header | `X-SAP-Destination: SAP_DEV` |

   Nothing cross-checks them at startup — a mismatch shows up as a request
   error naming the destination and the ones that exist (see Troubleshooting).

   **Sharing one Qdrant** with another local kit or deployment? Give each its
   own `LLM_AGENT_QDRANT_PREFIX` (default `cloud-llm-hub`), e.g.
   `LLM_AGENT_QDRANT_PREFIX=cloud-llm-hub-mine`. Collections are named after
   the prefix, so two runs with the same prefix share (and overwrite) the
   same tool stores.

2. **Start Qdrant:**

   ```bash
   docker compose -f docker-compose.local.yml up -d
   ```

   Qdrant listens on host ports `6433` (REST) and `6434` (gRPC) — not the
   default `6333`, which other projects' Qdrant containers commonly occupy.

3. **Pull the Ollama models:**

   ```bash
   ollama pull qwen2.5:14b
   ollama pull bge-m3
   ```

   Pull **the exact model `LLM_AGENT_MODEL` names** in `.env` (`qwen2.5:14b`
   in the example). Using another model? Change `LLM_AGENT_MODEL` and pull
   that one — `ollama list` shows what is there.

4. **Install dependencies:**

   ```bash
   npm ci
   ```

5. **Run:**

   ```bash
   npm run dev:local
   ```

   This warns if a leftover `default-env.json` would make the run hybrid,
   builds the tool vectors for this configuration, then starts
   `cds watch --profile development`. The build step writes the Qdrant
   `tools-reader` / `tools-writer` stores — it skips them when they already
   match the current embedding model and tool set, and re-builds them in
   place when either changes.

## Calling the agent

```bash
curl http://localhost:4004/v1/chat/completions \
  -H "Authorization: Basic YWxpY2U6" \
  -H "X-SAP-Destination: SAP_DEV" \
  -H "x-sap-login: DEVELOPER" \
  -H "x-sap-password: <your-password>" \
  -H "x-sap-client: 100" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"List packages starting with Z"}]}'
```

`Authorization: Basic YWxpY2U6` is the mocked local user `alice` (no
password) — see `cds watch --profile development` auth. `x-sap-login` /
`x-sap-password` are the caller's own SAP credentials, sent per request; the
hub never holds a default SAP user.

## Chat without SAP (LLM-only)

**TL;DR:** to talk to the LLM alone, leave `LLM_AGENT_MCP_DESTINATION`
unset and send no `X-SAP-Destination`.

How a chat request picks its destination, in order:

1. the `X-SAP-Destination` header;
2. else the destination this chat session last used;
3. else `LLM_AGENT_MCP_DESTINATION`.

- **A destination was picked** → the hub connects to SAP *before* the LLM
  runs. This env destination uses `NoAuthentication`, so the request needs
  `x-sap-login` and `x-sap-password`. Without them:
  `SAP_CREDENTIALS_REQUIRED` ("requires your SAP username and password").
- **None was picked** → the LLM-only agent answers (no ABAP tools, no SAP).

So with `LLM_AGENT_MCP_DESTINATION` set, **every** chat needs SAP
credentials — even one without the header. To get LLM-only chat:

```bash
# .env: keep `destinations`, comment out the default
# LLM_AGENT_MCP_DESTINATION=SAP_DEV
```

Then restart and call without the header:

```bash
curl http://localhost:4004/v1/chat/completions \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with one word: pong"}]}'
```

The startup log then says `No MCP destination configured — starting in
LLM-only mode`. SAP still works per request: add `X-SAP-Destination: SAP_DEV`
plus the `x-sap-*` credentials.

`LLM_AGENT_ALLOW_LLM_ONLY_FALLBACK=true` does **not** do this. It only
applies while the default destination is not ready yet (still building, or
unreachable at init); once it is ready, it changes nothing.

## Troubleshooting

- **"Tool vectors … were not built"** — the startup error naming
  `tools/generate-tool-embeddings.ts`. Run `npm run dev:local` again (or
  `npx tsx tools/generate-tool-embeddings.ts` on its own) so the build step
  can finish before the server takes traffic.
- **The `default-env.json` warning** — that file's `VCAP_SERVICES` point the
  run at real BTP services (hybrid mode), not the local stack this guide
  sets up. Move it aside (`mv default-env.json default-env.json.bak`) for a
  BTP-free run.
- **Port 6433 is in use** — another local Qdrant (or a leftover container
  from a previous run) already holds it. `docker compose -f
  docker-compose.local.yml down` first, or stop whatever else is bound to
  6433/6434.
- **`DESTINATION_RESOLUTION_FAILED` … `destination X is not in the
  destinations variable (known: …)`** — the name in `X-SAP-Destination` (or
  `LLM_AGENT_MCP_DESTINATION`) is not in your `destinations` JSON. The
  message lists the names that are. Make the three names match (step 1).
- **`SAP_CREDENTIALS_REQUIRED` on a plain chat** — a default destination is
  set. Send `x-sap-login` / `x-sap-password`, or run LLM-only (see
  [Chat without SAP](#chat-without-sap-llm-only)).
- **A small model does not call tools** — see the note below; drop to a
  smaller model only after confirming tool calling works with `qwen2.5:14b`.

## A development setup, not production

Local models are weaker at tool calling than SAP AI Core's deployed models.
Expect more missed or malformed tool calls, especially with a model smaller
than `qwen2.5:14b`. This kit is for iterating on the hub itself, not for
judging model quality or running load tests.
