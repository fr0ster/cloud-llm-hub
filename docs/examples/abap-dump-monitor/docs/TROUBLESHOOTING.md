# Troubleshooting

A field guide based on real bumps encountered while deploying this example to a vanilla `ai-applications`-style BTP subaccount. Each item shows the symptom you'll see, the root cause, and the fix applied in this repository.

## Deploy fails — "no entitlement for HANA Cloud"

**Symptom:** `cf deploy` aborts at `abap-dump-monitor-db` with `Failed to open connection to the database`. The subaccount has no HANA Cloud assigned.

**Cause:** the example originally used HANA Cloud HDI for `MonitoredDump` storage. Most demo subaccounts don't have HANA Cloud entitlement.

**Fix:** the deployable variant uses **SQLite at `/tmp/abap-dump-monitor.sqlite`** (ephemeral; rows lost on CF restart). To switch back to HANA in a fork, change `cds.requires.db.[production]` to `{ "kind": "hana-cloud" }` and restore the `abap-dump-monitor-db` resource + `abap-dump-monitor-db-deployer` module in `mta.yaml`. See `DEPLOYMENT.md` "Storage" callout.

## App boots, then crashes — `Cannot find module '@cap-js/sqlite'`

**Symptom:** `cf app abap-dump-monitor-srv` shows `web:0/1`, logs contain `Error: Cannot find module '/home/vcap/app/@cap-js/sqlite'`.

**Cause:** CAP at runtime needs the database adapter as an explicit `dependencies` entry. `@sap/cds-dk` (devDep) only pulls it in at build time.

**Fix:** add `"@cap-js/sqlite": "2.2.0"` (exact, no caret) to `dependencies` in `package.json`. Exact pin avoids a regression to `@cap-js/sqlite@2.2.2`, one of the four packages compromised by the Shai-Hulud supply-chain worm (2026-04-29). Audit `package-lock.json` after every `npm install`.

## `mbt build` fails — `cpSyncCheckPaths ... ENOENT`

**Symptom:** silent `mbt build` failure (or visible `cpSyncCheckPaths` Node error) when the build tries to copy the Fiori webapp folder.

**Cause:** `build-parameters.commands` in `mta.yaml` run with **cwd = the module's `path:`** (here `gen/srv`), **not** the project root. The literal `app/monitor/webapp` resolves to `gen/srv/app/monitor/webapp` — non-existent.

**Fix:** module-relative paths. From `gen/srv`, the source is `../../app/monitor/webapp`, the dest is `app/monitor/webapp`:

```yaml
- node -e "require('fs').cpSync('../../app/monitor/webapp','app/monitor/webapp',{recursive:true})"
```

Same idiom that the cloud-llm-hub root uses for its approuter module.

## Approuter login fails — "Authorization Request Error - request invalid"

**Symptom:** browser is redirected to XSUAA after hitting any approuter route, but XSUAA shows a static error page "There was an error. The request for authorization was invalid."

**Cause:** the freshly created `xsuaa` service instance has no `oauth2-configuration.redirect-uris`, so its allow-list is `localhost` only. When the approuter redirects to its `/login/callback` on `<app>.cfapps.<region>.hana.ondemand.com`, XSUAA refuses.

**Fix:** add to `xs-security.json`:

```json
"oauth2-configuration": {
  "redirect-uris": [
    "https://*.cfapps.eu10-004.hana.ondemand.com/**",
    "https://*.cfapps.us21.hana.ondemand.com/**"
  ]
}
```

Wildcard at the host level makes the example portable across regions and across cf-app names — no per-deploy edits needed. After redeploy, XSUAA accepts the approuter callback.

## After login — "Провайдер ідентичності не може обробити отриманий запит на автентифікацію"

**Symptom:** XSUAA accepts the OAuth request and forwards to IAS, but IAS shows an error page in the user's locale ("Identity provider cannot process the received authentication request"), with a correlation ID. The redirect-uri allow-list is fine; it's IAS one layer down.

**Cause:** the new xsuaa instance was created with `tenant-mode: "dedicated"` while the IAS trust in this subaccount is configured for **shared-tenant** apps. IAS rejects the OAuth request from a "dedicated" client because it can't bind it to a tenant.

**Fix:** set `"tenant-mode": "shared"` in `xs-security.json`. Mirrors what `cloud-llm-hub`'s root and staging xsuaa instances use. Redeploy; cookies must be cleared for a fresh attempt because the failed IAS attempt left a sticky negative cache.

## UI: white screen with "FilterUtils.ts:980 Unexpected token '\\'" in console

**Symptom:** Fiori Elements V4 List Report stays blank; DevTools console shows `SyntaxError: Unexpected token '\\', "[\\{"name":""... is not valid JSON` originating in `FilterUtils.ts:980 → getFilterPropertyInfo → _getSelectionFields`. The `PageReady` event never fires.

**Cause:** **the manifest was hand-written.** Even if the JSON looks valid, FE V4 enforces strict expectations on the shape of `sap.app.dataSources`, `sap.ui5.routing.targets`, and SelectionFields/FieldGroup encodings that are easy to get subtly wrong. The crash is in FE's filter-state handling deep in the templates, with no useful surface error.

**Fix:** **don't hand-write manifests.** Generate the Fiori app via the canonical SAP tooling. The Yeoman generator `@sap/generator-fiori` is interactive, but its underlying writer library `@sap-ux/fiori-elements-writer` has a programmatic API. Example one-shot scaffold script:

```js
// /tmp/gen-fiori.mjs
import { generate, TemplateType } from '@sap-ux/fiori-elements-writer';
import { promises as fs } from 'node:fs';
import { create as memFs } from 'mem-fs';
import { create as memFsEditor } from 'mem-fs-editor';

const metadata = await fs.readFile(
  'gen/srv/srv/odata/v4/MonitorService.xml', 'utf-8');

const editor = memFsEditor(memFs());
await generate('app/monitor', {
  app: { id: 'monitor', title: 'ABAP Dump Monitor' },
  template: { type: TemplateType.ListReportObjectPage,
    settings: { entityConfig: { mainEntityName: 'MonitoredDump' } } },
  service: { path: '/odata/v4/admin/', version: '4', metadata },
  ui5: { framework: 'SAPUI5', minUI5Version: '1.121.0', theme: 'sap_horizon' },
  package: { addAnnotations: false, disableCapRootPkgJsonUpdates: true }
}, editor);

await new Promise((r) => editor.commit(r));
```

UI annotations (`UI.LineItem`, `UI.HeaderInfo`, `UI.Facets` etc.) live in `srv/monitor-annotations.cds` server-side; the generated app picks them up automatically via `$metadata`. Hand-written annotations are fine — only the manifest/Component layer must come from the generator.

## Static UI shell is anonymous

**Symptom:** `GET /monitor/webapp/index.html` (or any static asset) returns 200 to anonymous callers; CONSUMER-GUIDE that says "Admin or Viewer required" doesn't reflect runtime.

**Root cause:** CAP applies authentication at the OData/service layer, not as Express middleware on `cds.on('bootstrap')`. Static `express.static` mounts there bypass the auth chain. The cloud-llm-hub root uses the same pattern for `/chat/webapp` — not a bug, an architectural choice.

**Fix:** in front of CAP, deploy the **`approuter.nodejs` module** in `mta.yaml`. It triggers XSUAA login for anonymous requests and forwards authenticated traffic to srv via destination `srv-api`. Without approuter, the UI shell stays public; data is still protected because OData enforces `@(requires: 'Viewer')` per service. Document this trade-off explicitly in `CONSUMER-GUIDE.md`.

## `npm test` after `npm run build` — Jest haste duplicate package name warning

**Symptom:** running tests shortly after a build prints `jest-haste-map: Haste module naming collision: monitor` referring to `gen/srv/package.json` — both manifest declarations carry the same `"name": "abap-dump-monitor"`.

**Fix:** in the sub-project's Jest config (root `package.json`'s `"jest"` block) add:

```json
"modulePathIgnorePatterns": ["<rootDir>/gen/"],
"testPathIgnorePatterns": ["/node_modules/", "<rootDir>/gen/"]
```

## CF session keeps expiring during `cf deploy`

**Symptom:** mid-deploy log shows `Authentication has expired. Please log back in.` followed by `FAILED`. The mtar finishes uploading but service updates never complete.

**Cause:** XSUAA tokens for `cf` last ~10 minutes; long deploys (10+ minutes for an app+approuter combo) outlast a single token. With SSO logins (`cf login --sso`) there's no refresh token to renew.

**Fix:** keep a fresh login window open in another terminal during deploys; if the deploy errors out, `cf login --sso` again and re-run `cf deploy mta_archives/...mtar -e .mtaext`. The CLI is idempotent — it picks up where it left off.

## Recommended order for first deploy

1. Pin `mbt@1.2.34` in repo-root `devDependencies` (avoids the Shai-Hulud `mbt@1.2.48`).
2. Confirm the subaccount has no HANA Cloud — accept SQLite or arrange entitlement first.
3. Provision the `cloud-llm-hub-analyst-consumer` xsuaa key via `cf create-service-key` and copy values into `.env`.
4. Apply both `tenant-mode: shared` and `oauth2-configuration.redirect-uris` to `xs-security.json` before the very first `cf deploy` — backsetting them later requires the xsuaa instance to be deleted and recreated to pick up the new schema.
5. Generate the Fiori app via `@sap-ux/fiori-elements-writer`, never by hand.
