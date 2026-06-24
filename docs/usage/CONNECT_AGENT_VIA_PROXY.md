# Connect Cline / Cursor to the **llm-agent** (`/v1`) via the local proxy

> **TL;DR** — Run `mcp-abap-adt-proxy` locally (same binary as for MCP). It
> listens on `http://localhost:3001`, forces the XSUAA token and supplies your
> **default** SAP destination + ABAP credentials, and forwards everything to the deployed
> `cloud-llm-hub-srv`. Point any OpenAI-compatible editor at
> `http://localhost:3001/v1` with a **dummy** API key — the proxy supplies the
> real token.

This covers the **agent** channel — the SmartAgent chat pipeline:

- OpenAI-compatible: `POST /v1/chat/completions`
- Anthropic Messages: `POST /v1/messages`

For raw MCP ABAP tools, see [CONNECT_MCP_VIA_PROXY.md](./CONNECT_MCP_VIA_PROXY.md).

---

## Why the same proxy works for `/v1`

`mcp-abap-adt-proxy` is a **transparent, path-agnostic** reverse proxy. It routes
by the destination header, **not** by URL path, and forwards `req.url`
unchanged — so `/v1/chat/completions` and `/v1/messages` go through exactly like
`/mcp/stream/http`. On every request it:

1. **forces the `Authorization` header** — drops the client's and injects a fresh
   XSUAA JWT, so the editor's "API key" is irrelevant (use any placeholder);
2. supplies the SAP headers (`x-sap-destination`, `x-sap-client`, `x-sap-login`,
   `x-sap-password`) as **defaults** from your config — used when the client
   sends none; an explicit non-`Authorization` client header overrides them;
3. forwards to the deployed `cloud-llm-hub-srv`.

Because clients can override the SAP defaults, **do not expose the proxy to
untrusted clients/networks**.

---

## 1. Proxy setup (shared with the MCP doc)

The proxy config is identical to the MCP channel — one subaccount yaml + one
session env-file. Full details in
[CONNECT_MCP_VIA_PROXY.md](./CONNECT_MCP_VIA_PROXY.md#1-one-time-config-two-small-files).
In short:

`~/.config/mcp-abap-adt/proxy/<name>.yaml`:

```yaml
transport: streamable-http
httpPort: 3001
httpHost: "127.0.0.1"
btpDestination: "acme-sandbox"
targetUrl: "https://<subaccount>-cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com"
defaultHeaders:
  x-sap-destination: "S4HANA_DEV"
  x-sap-client: "600"
  x-sap-login: "${SAP_LOGIN}"
  x-sap-password: "${SAP_PASSWORD}"
```

`~/.config/mcp-abap-adt/sessions/<system>.env` (`chmod 600`):

```ini
SAP_LOGIN=DEVELOPER
SAP_PASSWORD=your-abap-password
```

Start it (**requires `mcp-abap-adt-proxy` ≥ 1.6** for `--env-file` / `${}`
interpolation — check `mcp-abap-adt-proxy --version`):

```bash
cf login --sso
cf target -o <org> -s <space>

mcp-abap-adt-proxy \
  --config ~/.config/mcp-abap-adt/proxy/acme-sandbox.yaml \
  --env-file ~/.config/mcp-abap-adt/sessions/dev.env
```

The proxy binds **`127.0.0.1`** (yaml default) and serves **both**
`/mcp/stream/http` and `/v1/*` on port 3001.

> **⚠️ Remote / dev-container editors only:** add `--http-host=0.0.0.0` only if
> the editor runs in WSL / a container / over SSH and can't reach the host
> `127.0.0.1`. It exposes a proxy that injects your XSUAA token + SAP password to
> the network — prefer an SSH tunnel over raw `0.0.0.0`. (The bundled
> `npm run proxy` uses an older 1.2.0 proxy without `--env-file` — use the global
> binary for this flow.)

---

## 2. Point your editor at `http://localhost:3001/v1`

Because the proxy replaces `Authorization`, the **API key field can be any
non-empty placeholder** (e.g. `proxy`).

### Cursor

Settings → **Models** → OpenAI API Key:

- **Base URL:** `http://localhost:3001/v1`
- **API Key:** `proxy` (placeholder — discarded by the proxy)
- **Model:** `default`

### Continue (VS Code / JetBrains)

`~/.continue/config.yaml`:

```yaml
models:
  - model: default
    title: Cloud LLM Hub (via proxy)
    provider: openai
    apiBase: http://localhost:3001/v1
    apiKey: proxy        # placeholder — proxy injects the real XSUAA token
```

### Cline (OpenAI-compatible mode)

In Cline's API provider settings choose **OpenAI Compatible**:

- **Base URL:** `http://localhost:3001/v1`
- **API Key:** `proxy`
- **Model:** `default`

### Anthropic-style clients

Point `ANTHROPIC_BASE_URL` at `http://localhost:3001` (the proxy forwards
`/v1/messages`); the API key is again a placeholder.

---

## Notes & limits

- **SAP system per proxy instance.** With the header-free editor configs shown
  here, the SAP system/credentials come from the proxy yaml defaults. To use
  several systems safely, run a separate proxy per system on a different
  `httpPort` with its own `--config` / `--env-file`, and point a second editor
  profile at it. (Advanced clients *can* override the non-`Authorization` SAP
  headers explicitly — so this isolation holds only for header-free clients on a
  trusted local proxy.)
- **No agent configurator yet.** For MCP there's `npm run update:cline`; there is
  **no `/v1` generator** today — the proxy is the way. Extending the configurator
  to emit OpenAI/Anthropic editor profiles is a possible future improvement.
- **Model selection:** use `default`, or any model the deployment exposes (see
  `GET /v1/models` — through the proxy: `curl http://localhost:3001/v1/models`).

---

## Troubleshooting

- 401 / token errors despite a placeholder key → that's expected only if the
  proxy isn't injecting; confirm the proxy is running and CF target matches the
  yaml subaccount (`WrongAudienceError` = subaccount mismatch).
- Empty/!ready model list → deployment/AI-Core issue, not the proxy; check
  `curl http://localhost:3001/v1/models`.
- ABAP `SAP_CREDENTIALS_REQUIRED` → env-file creds or `x-sap-destination`
  wrong; see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
