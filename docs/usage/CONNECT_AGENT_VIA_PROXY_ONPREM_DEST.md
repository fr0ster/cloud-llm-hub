# Connect Cline / Cursor to the **chat agent** (`/v1`) via the local proxy

> **TL;DR** — Run `mcp-abap-adt-proxy` on your machine. It handles the login
> (XSUAA token + your SAP user) and forwards to the deployed `cloud-llm-hub`.
> Point any OpenAI-compatible editor at `http://localhost:3001/v1` with a dummy
> API key — no token or SAP password in the editor config.

This is for using the **chat agent** (the SmartAgent pipeline, OpenAI/Anthropic
style).

> **Scope:** this guide covers **only** connecting to **on-premise ABAP systems
> exposed through BTP destinations** (via Cloud Connector) in the subaccount
> where `cloud-llm-hub` is deployed. Other destination types (Internet,
> principal propagation, etc.) are out of scope here.

You set this up **once**, then the editor connects with a trivial config.

---

## Step 0 — install the tools

You need **Node.js** (provides `npm`/`npx`) plus:

- **Cloud Foundry CLI** (`cf`) — for the login and fetching the service key.
  Install per the [official guide](https://docs.cloudfoundry.org/cf-cli/install-go-cli.html)
  (Homebrew: `brew install cloudfoundry/tap/cf-cli`).
- **The proxy** — `mcp-abap-adt-proxy`, version **≥ 1.6**:
  ```bash
  npm i -g @mcp-abap-adt/proxy
  mcp-abap-adt-proxy --version        # must be >= 1.6
  ```

---

## Step 1 — two small config files

### `~/.config/mcp-abap-adt/proxy/myconfig.yaml`

```yaml
transport: streamable-http
httpPort: 3001             # local port the editor connects to — pick any free port;
                          # each proxy you run at the same time needs its own
btpDestination: "<YOUR_BTP_DESTINATION>"   # service-key name (see Step 2)
targetUrl: "https://<your cloud-llm-hub-srv route>"

defaultHeaders:
  x-sap-destination: "<YOUR_DESTINATION>"   # e.g. S4HANA_DEV
  x-sap-client: "<client>"                   # optional, e.g. 100
  x-sap-login: "${SAP_LOGIN}"
  x-sap-password: "${SAP_PASSWORD}"

browser: "system"          # open the OAuth login in your default browser — leave as-is
browserAuthPort: 7778      # local port for the OAuth redirect — see "Good to know"
```

- **`targetUrl`** — the real address of your deployment. Get it with:
  `cf app cloud-llm-hub-srv` → copy the route → prefix `https://`.
- **`<YOUR_DESTINATION>` / `<client>`** — the SAP system + mandant you want.

### `~/.config/mcp-abap-adt/sessions/mysession.env`  (`chmod 600`)

```ini
SAP_LOGIN=<your-sap-user>
SAP_PASSWORD=<your-sap-password>
```

Your SAP login/password go **here only** — never in the editor. The `${...}`
placeholders in the yaml are filled from this file at launch.

> The `x-sap-login` / `x-sap-password` headers are needed only to reach
> **on-premise ABAP systems** through a BTP destination (Cloud Connector) in the
> subaccount where `cloud-llm-hub` is deployed. Destinations that don't use ABAP
> basic auth don't need them — drop those two lines (and the env-file) in that case.

---

## Step 2 — one-time: the service key

The proxy gets its login token from a **service key** file named after your
`btpDestination`:

```
~/.config/mcp-abap-adt/service-keys/<YOUR_BTP_DESTINATION>.json
```
*(Windows: `%USERPROFILE%\Documents\mcp-abap-adt\service-keys\...`)*

Create it once, with the CF CLI logged into the right subaccount:

```bash
cf create-service-key cloud-llm-hub-auth mcp      # first time only
cf service-key cloud-llm-hub-auth mcp             # copy the printed {...} into
#   ~/.config/mcp-abap-adt/service-keys/<YOUR_BTP_DESTINATION>.json
```

> Working inside the `cloud-llm-hub` repo? `npm run get:key` runs the above and
> writes the file for you.

Re-do this if you switch subaccounts (a stale key → login errors).

---

## Step 3 — start the proxy

```bash
cf login --sso
cf target -o <org> -s <space>

mcp-abap-adt-proxy \
  --config ~/.config/mcp-abap-adt/proxy/myconfig.yaml \
  --env-file ~/.config/mcp-abap-adt/sessions/mysession.env
```

The proxy now listens on `http://localhost:3001`. First call opens a browser
login; after that it's cached.

---

## Step 4 — point your editor at `http://localhost:3001/v1`

The proxy replaces `Authorization`, so the **API key is any placeholder**.

> If you changed `httpPort`, use **that** port in the URLs below.

> **Model value.** Use the id `GET /v1/models` returns — it reports the model the
> deployment is actually running. Any other value is passed through to
> `getSmartAgent` as a requested model and, if it differs from the active one,
> triggers a **global** hot-swap that affects every caller (see
> ARCHITECTURE.md §7). Matching the reported id avoids that entirely.

**Cursor** — Settings → Models → OpenAI:
- Base URL: `http://localhost:3001/v1`
- API Key: `proxy` *(any value — the proxy replaces it)*
- Model: the id from `GET /v1/models`

**Continue** — `~/.continue/config.yaml`:
```yaml
models:
  - model: <id from GET /v1/models>
    provider: openai
    apiBase: http://localhost:3001/v1
    apiKey: proxy
```

**Cline** (OpenAI-compatible provider): Base URL `http://localhost:3001/v1`,
API Key `proxy`, Model `default`.

Anthropic-style clients: point `ANTHROPIC_BASE_URL` at `http://localhost:3001`.

---

## Good to know

- **Keep the editor config header-free.** The SAP system/credentials come from
  your yaml. (A client *can* send its own `x-sap-*` headers to override them —
  which is why you should not expose the proxy to others.)
- **Stay on localhost.** The proxy binds `127.0.0.1`. Only add
  `--http-host=0.0.0.0` if your editor runs in WSL/a container and can't reach
  the host — and then only on a trusted network (it would expose your token +
  SAP password). Prefer an SSH tunnel.
- **One SAP system per proxy.** For several systems, run several proxies at
  once — give each its own **`httpPort`** *and* its own **`browserAuthPort`**,
  otherwise they clash. Change `browserAuthPort` only if that port is busy or you
  run multiple proxies; change `browser` only to force a non-default browser.
- **Model:** use `default`, or any the deployment exposes
  (`curl http://localhost:3001/v1/models`).
- **Trailing `UNVERIFIED_WRITE:` line *(v6.28+)*:** a response may end with one —
  a soft warning that a claimed create/update/activate wasn't confirmed by the
  actual tool results. Verify against the system before relying on it; the hub
  can disable this check entirely via `LLM_AGENT_STEP_REVIEW_ENABLED=false`.

## If something fails

- Nothing on `:3001` → proxy not started / wrong `cf target`.
- `WrongAudienceError` 500 → service key is from a different subaccount than
  `targetUrl`; re-run `npm run get:key` and restart.
- `SAP_CREDENTIALS_REQUIRED` / 401 from SAP → check the `.env` login/password and
  that `x-sap-destination` is a real destination. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
