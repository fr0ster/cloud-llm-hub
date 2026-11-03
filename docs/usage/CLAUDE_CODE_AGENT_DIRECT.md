# Connecting Claude Code directly to the agent MCP

This guide connects Claude Code straight to the hub's agent MCP endpoint on SAP BTP, without a local proxy. For the agent MCP tools see [CLAUDE_CODE_AGENT.md](./CLAUDE_CODE_AGENT.md); for a connection through a local proxy see [CONNECT_AGENT_VIA_PROXY_ONPREM_DEST.md](./CONNECT_AGENT_VIA_PROXY_ONPREM_DEST.md).

Two separate authorizations are involved:

1. **Access to the hub (XSUAA).** Claude Code runs the OAuth authorization-code flow in the browser itself and adds `Authorization: Bearer <JWT>` to every request.
2. **Access to SAP.** The SAP user and password travel in `X-SAP-*` headers taken from environment variables. The hub passes them to SAP and does not store them.

The JWT lets you into the hub; the `X-SAP-*` headers let the hub into SAP on your behalf.

## Parameters

| What | Value |
|---|---|
| Endpoint | `https://<hub-srv-host>/mcp/agent/stream/http` |
| XSUAA | `https://<subdomain>.authentication.<region>.hana.ondemand.com` |
| Service key | the hub's XSUAA service key (`credentials.clientid`, `clientsecret`, `xsappname`, `url`) |
| SAP destination | `<DESTINATION>` (the `list_destinations` tool lists them) |
| SAP client | `<client>`, for example `100` |
| SAP credentials | a local env file with `SAP_LOGIN` and `SAP_PASSWORD` |
| Roles | `MCP_Reader`, `MCP_Developer` |

## 1. `.mcp.json`

```json
{
  "mcpServers": {
    "sap-agent-direct": {
      "type": "http",
      "url": "https://<hub-srv-host>/mcp/agent/stream/http",
      "headers": {
        "X-SAP-Destination": "<DESTINATION>",
        "X-SAP-Client": "<client>",
        "X-SAP-Login": "${SAP_LOGIN}",
        "X-SAP-Password": "${SAP_PASSWORD}"
      },
      "oauth": {
        "clientId": "<credentials.clientid>",
        "callbackPort": 7888,
        "authServerMetadataUrl": "https://<subdomain>.authentication.<region>.hana.ondemand.com/.well-known/openid-configuration",
        "scopes": "openid <xsappname>.MCP_Reader <xsappname>.MCP_Developer"
      }
    }
  }
}
```

Rules:

- **Do not add an `Authorization` header.** If it is present, the built-in OAuth is switched off.
- **The field is `scopes` (plural).** With `scope`, Claude Code ignores the value and requests every scope from the XSUAA metadata, including `email`; XSUAA then answers `invalid_scope: email`.
- **`authServerMetadataUrl` is required.** The hub does not serve `/.well-known/...` itself (404).
- **`clientId` and `xsappname` come from the service key.** `xsappname` looks like `cloud-llm-hub-<guid>!t<number>`.
- **The file contains no secrets**, so it can be committed.

## 2. OAuth client secret

The client secret is in the service key (`credentials.clientsecret`). Never put it in `.mcp.json`, git or a chat.

Pass it once to `claude mcp add`. The `MCP_CLIENT_SECRET` variable is read **only by that command**; Claude Code does not use it during login. The secret is stored in Claude Code's `.credentials.json` (in `CLAUDE_CONFIG_DIR`, by default `~/.claude`).

```powershell
$k = (Get-Content "<path-to-service-key>.json" -Raw | ConvertFrom-Json).credentials
$env:MCP_CLIENT_SECRET = $k.clientsecret
claude mcp add --transport http --scope project --client-id $k.clientid --client-secret --callback-port 7888 `
  sap-agent-direct "https://<hub-srv-host>/mcp/agent/stream/http" `
  --header 'X-SAP-Destination: <DESTINATION>' --header 'X-SAP-Client: <client>' `
  --header 'X-SAP-Login: ${SAP_LOGIN}' --header 'X-SAP-Password: ${SAP_PASSWORD}'
Remove-Item env:MCP_CLIENT_SECRET
```

Keep headers with `${...}` in single quotes so that PowerShell does not substitute them itself.

The command creates or overwrites the entry in `.mcp.json`. If the server already exists, run `claude mcp remove sap-agent-direct -s project` first. Afterwards add `authServerMetadataUrl` and `scopes` to the `oauth` block by hand; `claude mcp add` cannot set them.

## 3. SAP environment variables

Set the variables **in the same terminal** you start `claude` from, and **before** starting it:

```powershell
Get-Content "<path-to-sap-env-file>.env" | ForEach-Object {
  if ($_ -match '^\s*(SAP_LOGIN|SAP_PASSWORD)=(.*)$') { Set-Item "env:$($Matches[1])" $Matches[2].Trim('"', "'") }
}
claude
```

If the variables are empty, the headers are sent empty and the configuration hash (section 4) does not match.

## 4. Pitfall: configuration hash and client secret

Claude Code stores the client secret and tokens under the key `sap-agent-direct|<hash>`. The hash is computed from `type`, `url` and `headers`:

- `claude mcp add` computes it from the literal `${SAP_LOGIN}` strings;
- during login, Claude Code computes it from the headers **with the variables already substituted**.

So the secret is stored under one key and looked up under another. As a result, the code-for-token exchange runs without the secret, XSUAA answers `Bad credentials`, and `/mcp` shows `needs authentication`.

Fix: copy the secret entry to the "expanded" hash. The script below makes a backup, prints no secrets, and must run in a terminal where `SAP_LOGIN` and `SAP_PASSWORD` are already set. Run it from the directory that contains `.mcp.json`.

```powershell
node -e "
const c=require('crypto'),fs=require('fs'),os=require('os'),path=require('path');
const s=JSON.parse(fs.readFileSync('.mcp.json')).mcpServers['sap-agent-direct'];
const h=o=>c.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0,16);
const raw=h({type:s.type,url:s.url,headers:s.headers});
const exp=h({type:s.type,url:s.url,headers:{...s.headers,'X-SAP-Login':process.env.SAP_LOGIN,'X-SAP-Password':process.env.SAP_PASSWORD}});
const f=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'.credentials.json');
const j=JSON.parse(fs.readFileSync(f,'utf8'));
const src='sap-agent-direct|'+raw, dst='sap-agent-direct|'+exp;
if(!j.mcpOAuthClientConfig?.[src]?.clientSecret) throw new Error('no secret under '+src+': repeat section 2');
fs.copyFileSync(f,f+'.bak-'+Date.now());
j.mcpOAuthClientConfig[dst]={...j.mcpOAuthClientConfig[src]};
fs.writeFileSync(f,JSON.stringify(j));
console.log('copied',src,'->',dst);
"
```

The hash changes, and sections 2–4 must be repeated, when you:

- change `SAP_LOGIN` or `SAP_PASSWORD`;
- change `url`, `type` or any header (`X-SAP-Client`, `X-SAP-Destination`).

Changes in the `oauth` block (for example `scopes`) do not change the hash; they take effect after a new login.

## 5. Login and check

1. Restart `claude` in the terminal with the variables set.
2. Approve the project server.
3. `/mcp` → `sap-agent-direct` → Authenticate, and sign in in the browser.
4. Check: call `list_destinations`, then `execute_step` with a read, for example "show the definition of table T000".

If you changed `scopes`, use Re-authenticate: the stored token carries the old scope set.

## 6. Secrets

- **OAuth client secret:** only in Claude Code's `.credentials.json`. Not in `.mcp.json`, git or a chat.
- **SAP user and password:** only in environment variables. `.mcp.json` holds only `${...}`.
- **`.credentials.json` and its `.bak-*` copies:** never copy or commit them. Delete backups when they are no longer needed.
- **If a secret leaked into a chat or log:** create a new service key (`cf create-service-key`) and repeat sections 2–4.
- **Token:** short-lived; Claude Code refreshes it. If not, Authenticate again.

## 7. Common errors

| Symptom | Cause | Action |
|---|---|---|
| `invalid_scope: email` | `scope` instead of `scopes` in the config | rename the field |
| `invalid_scope` on `MCP_Reader` or `MCP_Developer` | the user has no role collection with that role | assign the role in the BTP cockpit |
| `Bad credentials` after login | no secret under the expected hash | section 4 |
| `needs authentication` after changing headers or the password | the hash changed | sections 2–4 |
| 401 from the hub | missing or expired token, or missing role | Authenticate again, check roles |
| redirect URI error | `http://localhost:7888/callback` not allowed for the client | adjust `xs-security` |
| `Bad credentials` from SAP | wrong user or password, locked user, wrong client | check the env file and `X-SAP-Client` |
| empty `X-SAP-*` headers | variables not set in the terminal | section 3 |
