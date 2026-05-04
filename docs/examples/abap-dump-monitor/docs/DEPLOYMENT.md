# Deployment

> **Storage:** this example uses **SQLite at `/home/vcap/app/db/abap-dump-monitor.sqlite`** for production. The file is **ephemeral** — every CF restart, restage, or scale-to-zero loses all `MonitoredDump` rows and `Setting` overrides (Setting is reseeded from env on next boot). This is fine for a demo or learning environment, but for any real use you must switch to HANA Cloud HDI: change `cds.requires.db.[production]` in `package.json` to `{ "kind": "hana-cloud" }` and restore the `abap-dump-monitor-db` resource + `abap-dump-monitor-db-deployer` module in `mta.yaml` (see git history of this file for the original HDI shape). HANA Cloud requires an entitlement on the target subaccount.


## 1. cloud-llm-hub consumer

The service must use the **analyst** consumer xsuaa, NOT the default reader.
Reader xsuaa silently excludes dump-related tools from the SmartAgent tool pool.

```bash
cf create-service-key cloud-llm-hub-analyst-consumer abap-dump-monitor-key
cf service-key cloud-llm-hub-analyst-consumer abap-dump-monitor-key
```

Copy `clientid`, `clientsecret`, `url` (without trailing path), and `xsuaa.url + /oauth/token` into `.mtaext` (see `.mtaext.example`).

## 2. Jira

- Create a Jira API token at https://jiraeu.epam.com → user → API tokens.
- Put email + token into `.mtaext` (`JIRA_USER` / `JIRA_TOKEN`).

## 3. Build & deploy

Either drive it through `bin/deploy.sh`. The script reads your `.mtaext`
(real `CLOUD_LLM_HUB_*`, `JIRA_*` values — copy from `.mtaext.example` first
and fill them in) and layers an auto-generated host extension on top that
sets `APPROUTER_HOST = <subaccount-subdomain>-abap-dump-monitor`. Then it
runs `cds build`, `mbt build`, `cf deploy`:

```bash
cd docs/examples/abap-dump-monitor
cp .mtaext.example .mtaext   # then fill in secrets
cf login --sso   # or cf target the right org/space
bin/deploy.sh
```

Or deploy manually:

```bash
cd docs/examples/abap-dump-monitor
cp .mtaext.example .mtaext
# fill in placeholders, set APPROUTER_HOST = "<subaccount-subdomain>-abap-dump-monitor"

npx cds build --production
npx mbt build -p=cf --mtar abap-dump-monitor_1.0.0.mtar
cf deploy mta_archives/abap-dump-monitor_1.0.0.mtar -e .mtaext
```

### Per-deployment `.mtaext` files (deploy/* branches)

Same policy as the parent cloud-llm-hub repo:

- `main` — only `.mtaext.example` is committed (sanitized template).
- `deploy/<env>` branches — non-secret deploy configuration **is** committed
  (e.g. `.mtaext.staging` with `APPROUTER_HOST`, `SAP_DESTINATION`,
  `CLOUD_LLM_HUB_URL`, etc.). Forced into git via `git add -f` once, then
  tracked normally despite the global `*.mtaext` ignore.
- Secrets (passwords, tokens, OAuth client secrets) **never** enter git on any
  branch — keep them in a local `.mtaext` (gitignored) or, for CI, inject
  through CF env / Vault / GitHub Actions secrets.

When promoting a fix from a feature branch to a deploy branch, cherry-pick only
the source changes; deploy-branch `.mtaext` files stay there.

## 4. Role assignment

Assign `AbapDumpMonitorAdmin` and/or `AbapDumpMonitorViewer` role collections in the BTP cockpit to your user.

## 5. Smoke test

```bash
TOKEN=...  # XSUAA token for an Admin user
curl -X POST "https://<app>/odata/v4/admin/pollNow" -H "Authorization: Bearer $TOKEN"
# expect: 200 ok; within ~30s a row appears in MonitoredDump and a Jira ticket is created
```
