# Deployment

> **Storage:** this example uses **SQLite at `/tmp/abap-dump-monitor.sqlite`** for production. The file is **ephemeral** — every CF restart, restage, or scale-to-zero loses all `MonitoredDump` rows and `Setting` overrides (Setting is reseeded from env on next boot). This is fine for a demo or learning environment, but for any real use you must switch to HANA Cloud HDI: change `cds.requires.db.[production]` in `package.json` to `{ "kind": "hana-cloud" }` and restore the `abap-dump-monitor-db` resource + `abap-dump-monitor-db-deployer` module in `mta.yaml` (see git history of this file for the original HDI shape). HANA Cloud requires an entitlement on the target subaccount.


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

```bash
cd docs/examples/abap-dump-monitor
cp .mtaext.example .mtaext
# fill in placeholders

npx cds build --production
npx mbt build -p=cf --mtar abap-dump-monitor_1.0.0.mtar
cf deploy mta_archives/abap-dump-monitor_1.0.0.mtar -e .mtaext
```

## 4. Role assignment

Assign `AbapDumpMonitorAdmin` and/or `AbapDumpMonitorViewer` role collections in the BTP cockpit to your user.

## 5. Smoke test

```bash
TOKEN=...  # XSUAA token for an Admin user
curl -X POST "https://<app>/odata/v4/admin/pollNow" -H "Authorization: Bearer $TOKEN"
# expect: 200 ok; within ~30s a row appears in MonitoredDump and a Jira ticket is created
```
