# Connect Cline / Cursor to the **MCP** endpoint via the local proxy

> **TL;DR** — Run `mcp-abap-adt-proxy` locally. It listens on
> `http://localhost:3001`, forces the XSUAA token and supplies your **default**
> SAP destination + ABAP credentials, and forwards everything to the deployed
> `cloud-llm-hub-srv`. Point your MCP client at
> `http://localhost:3001/mcp/stream/http` — no JWT, no SAP password in the
> editor config.

This covers the **MCP** channel (raw ABAP tools: read/search/CRUD objects,
`GetStructuresList`, etc.). For the chat agent (OpenAI/Anthropic `/v1`), see
[CONNECT_AGENT_VIA_PROXY.md](./CONNECT_AGENT_VIA_PROXY.md).

---

## Why the proxy

`mcp-abap-adt-proxy` is a **transparent, authorizing reverse proxy**. For every
request it:

1. **forces** the `Authorization` header — it drops whatever the client sent
   and injects a fresh **XSUAA JWT** (browser OAuth on first call, cached after);
2. supplies the SAP headers (`x-sap-destination`, `x-sap-client`,
   `x-sap-login`, `x-sap-password`) as **defaults** from your config — applied
   first, so a header-free editor uses them. They are defaults, **not** locks:
   any non-`Authorization` header the client sends overrides them;
3. forwards the request **unchanged** to the deployed `cloud-llm-hub-srv`.

So with the header-free editor configs below, the editor never holds a token or
an SAP password — the proxy owns auth. Because clients *can* override the SAP
headers, **do not expose the proxy to untrusted clients/networks** (see the
`--http-host` warning).

---

## 1. One-time config (two small files)

### a) Subaccount config — `~/.config/mcp-abap-adt/proxy/<name>.yaml`

```yaml
transport: streamable-http
httpPort: 3001
httpHost: "127.0.0.1"

btpDestination: "acme-sandbox"            # CF subaccount routing for the JWT
targetUrl: "https://<subaccount>-cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com"

defaultHeaders:
  x-sap-destination: "S4HANA_DEV"          # which SAP system
  x-sap-client: "600"                       # mandant (optional)
  x-sap-login: "${SAP_LOGIN}"               # filled from --env-file
  x-sap-password: "${SAP_PASSWORD}"         # filled from --env-file

browser: "system"
browserAuthPort: 7778
```

`${SAP_LOGIN}` / `${SAP_PASSWORD}` are placeholders resolved at launch from the
env-file below — so credentials never live in the yaml.

### b) Session credentials — `~/.config/mcp-abap-adt/sessions/<system>.env`

```ini
SAP_LOGIN=DEVELOPER
SAP_PASSWORD=your-abap-password
```

> Keep this file `chmod 600`. One env-file per ABAP user/system; one yaml per
> subaccount. Mix and match at launch.

---

## 2. Start the proxy

> **Requires `mcp-abap-adt-proxy` ≥ 1.6** — the `--env-file` flag and
> `${VAR}` / `${VAR:-default}` interpolation in config/headers landed there.
> Check with `mcp-abap-adt-proxy --version`; install/upgrade the global binary
> (e.g. `brew upgrade mcp-abap-adt-proxy` or `npm i -g @mcp-abap-adt/proxy`).

```bash
cf login --sso                 # XSUAA browser auth source
cf target -o <org> -s <space>  # the subaccount that hosts cloud-llm-hub-srv

mcp-abap-adt-proxy \
  --config ~/.config/mcp-abap-adt/proxy/acme-sandbox.yaml \
  --env-file ~/.config/mcp-abap-adt/sessions/dev.env
```

- `--config` — the subaccount yaml (targetUrl + defaultHeaders).
- `--env-file` — the session creds that fill `${SAP_LOGIN}` / `${SAP_PASSWORD}`
  (resolution order: `process.env` → env-file → `${VAR:-default}`; an unresolved
  `${VAR}` without a default fails the proxy at startup).
- The proxy binds **`127.0.0.1`** (the yaml default) — editor on the same host.

Switch SAP system/user by pointing `--config` / `--env-file` at a different
pair — no editor change needed.

> **⚠️ Remote / dev-container editors only:** if VS Code/Cursor runs in WSL, a
> dev container, or over SSH and cannot reach `127.0.0.1` on the host, add
> `--http-host=0.0.0.0` to bind all interfaces. This **exposes a proxy that
> injects your XSUAA token and SAP password to anyone who can reach the port** —
> only do it on a trusted network, and prefer an SSH tunnel / port-forward over
> raw `0.0.0.0`.

> Repo shortcut `npm run proxy <DESTINATION>` exists, but it currently bundles an
> **older proxy (1.2.0) without `--env-file`/`${}` support** — use the global
> `mcp-abap-adt-proxy` for the flow above, or bump the devDependency.

---

## 3. Point your MCP client at the proxy

The proxy injects auth + SAP headers, so the client config is minimal.

### Cline (VS Code)

`~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "cloud-llm-hub": {
      "url": "http://localhost:3001/mcp/stream/http"
    }
  }
}
```

That's it — keep the config **header-free** so the SAP system/credentials come
from the proxy yaml defaults. (You *could* send explicit `X-SAP-*` headers here
to override them, but the clean setup leaves them out.) To work with several SAP
systems, run a separate proxy instance per system on a different port, each with
its own `--config` / `--env-file`, and point a second server entry at it.

### Cursor

Cursor Settings → **MCP** → Add server (HTTP):

```json
{
  "mcpServers": {
    "cloud-llm-hub": { "url": "http://localhost:3001/mcp/stream/http" }
  }
}
```

---

## Alternative: the MCP configurator (no proxy)

If you'd rather connect Cline **directly** to the deployed URL (no local proxy),
the repo ships a generator:

```bash
npm run update:cline        # writes cline_mcp_settings.json with a real JWT
```

Templates live in `docs/templates/mcp-config/` (`cloud-destination`,
`cloud-internet`, `direct-basic`, `direct-jwt`). This embeds a JWT + headers
directly in the editor config — simpler, but you manage token refresh yourself.
There is **no agent (`/v1`) equivalent of this generator yet** — for the agent,
use the proxy.

---

## Troubleshooting

- `proxy unreachable` / nothing on 3001 → proxy not started, or wrong CF target.
- `SAP_CREDENTIALS_REQUIRED` / 401 from ABAP → check the env-file creds and that
  the yaml `x-sap-destination` matches a real destination. See
  [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) and the proxy-routing lesson.
- `WrongAudienceError` 500 → CF target points at a different subaccount than the
  yaml `targetUrl`/`btpDestination`. Align them and restart.
