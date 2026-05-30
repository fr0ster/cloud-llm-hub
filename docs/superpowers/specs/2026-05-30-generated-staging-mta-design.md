# Generated staging MTA — design

> **TL;DR.** Stop forking `mta.yaml` on `deploy/acme-prod-stg`. Keep that
> branch's `mta.yaml` byte-identical to `main`. Generate the staging descriptor
> at deploy time by transforming the prod `mta.yaml` (rename identifiers →
> `-staging`), write it to a gitignored `mta.staging.generated.yaml`, and
> `mbt build -f` that. Result: the stg branch never conflicts with main again.

## Problem (root cause)

`.mtaext` overrides only parameters/properties of an existing MTA. It **cannot**
change the MTA `ID`, module/resource names, `provides`/`requires` wiring,
`xsappname`, or the `TENANT_HOST_PATTERN` literal. To run a separate staging
instance in the **same CF space** as prod (where those identifiers must differ,
or the deploy clobbers prod) the team forked the whole `mta.yaml` on
`deploy/acme-prod-stg`, renaming everything to `cloud-llm-hub-staging-*`.

That fork is what conflicts with `main` on every `merge origin/main` — at
minimum the `ID:` and `version:` lines. `sync-version.js` rewrites only the
version line, not the conflict hunk, so a botched resolve has twice slipped
leftover `<<<<<<<` markers into the committed `mta.yaml`.

There is also a stale `mta-staging.yaml` (a second full staging descriptor that
`tools/deploy.sh staging` references via `-f`) which has drifted and does NOT
match what is live — confirmed by route comparison: the live stg route
`acme-subaccount-cloud-llm-hub-staging.cfapps.eu10.hana.ondemand.com`
is produced by the forked `mta.yaml` + `.mtaext.staging`, not by
`mta-staging.yaml`.

## Approach (chosen: B — generate at build time)

Single source of truth: `mta.yaml` on `main` (prod identifiers). The staging
descriptor is **not stored in git** — it is generated each deploy by a YAML
transform of the prod descriptor.

```
mta.yaml (== main, ID cloud-llm-hub)
   │  tools/make-staging-mta.js   (rename identifiers)
   ▼
mta.staging.generated.yaml  (gitignored, ephemeral)
   │  mbt build -f mta.staging.generated.yaml
   ▼
cloud-llm-hub-staging_<v>.mtar
   │  cf deploy <mtar> -e .mtaext.staging
   ▼
staging instance (distinct names, same space)
```

`deploy/acme-prod-stg` then keeps `mta.yaml` identical to `main`, so the
merge can never conflict on it.

## Components

### 1. `tools/make-staging-mta.js`
Reads `mta.yaml`, parses with `js-yaml` (4.1.1, already present transitively),
applies the rename map below, writes `mta.staging.generated.yaml`.

| Field | prod | staging |
|---|---|---|
| `ID` | `cloud-llm-hub` | `cloud-llm-hub-staging` |
| `version` | `<from mta.yaml>` | unchanged (same number, from package.json sync) |
| every module/resource `name` matching `cloud-llm-hub*` | `cloud-llm-hub-X` | `cloud-llm-hub-staging-X` |
| every `provides[].name` / `requires[].name` referencing those | same rename | same rename |
| `resources[].parameters.config.xsappname` | `cloud-llm-hub-…-${space-guid}` | `cloud-llm-hub-staging-…-${space-guid}` |
| `TENANT_HOST_PATTERN` property | `^(.*)-cloud-llm-hub.${CF_LANDSCAPE}` | `^(.*)-cloud-llm-hub-staging.${CF_LANDSCAPE}` |

Version: **kept as-is** (the number from `mta.yaml`, which `sync-version.js`
already keeps == package.json). No `-rc` suffix — one version everywhere.

NOT touched (controlled by `.mtaext.staging`): `APPROUTER_HOST`, `CF_LANDSCAPE`,
all `LLM_AGENT_*`, `DESTINATION_MAPPING`, the `route:` template (it already reads
`${APPROUTER_HOST}.${CF_LANDSCAPE}`).

Rename rule: match the exact token `cloud-llm-hub` not already followed by
`-staging` (so `cloud-llm-hub-srv` → `cloud-llm-hub-staging-srv`, never
`-staging-staging`). Applied to scalar string values only — comments don't exist
post-parse, and the generated file is ephemeral so comment loss is irrelevant
(the prod `mta.yaml` source is only read, never written).

### 2. `.gitignore`
Add `mta.staging.generated.yaml`.

### 3. `tools/deploy.sh`
Staging branch: `node tools/make-staging-mta.js` then
`mbt build -f mta.staging.generated.yaml`. Prod branches unchanged (default
`mta.yaml`).

### 4. Delete `mta-staging.yaml`
Remove the stale dead descriptor. Drop its handling from `sync-version.js`
(staging version now comes from the same `mta.yaml` the generator reads).

### 5. De-fork `deploy/acme-prod-stg`
Make its `mta.yaml` identical to `main`'s (the rename is now build-time only).
Keep `.mtaext.staging` (the live, canonical staging param overrides).

## Out of scope (YAGNI)
- No new CF space (approach D rejected — needs infra, not warranted).
- Prod / acme-sandbox / customer-b flows untouched (already == main).
- No CI change — deploy stays manual local per existing practice.

## Testing
- Unit: `make-staging-mta` on a fixture mta.yaml asserts ID/names/
  TENANT_HOST_PATTERN renamed, `LLM_AGENT_*`/route template/version untouched, no
  `cloud-llm-hub-staging-staging` double.
- Manual: regenerate → `mbt build -f` → diff the generated descriptor's module
  list against the currently-live `cf mta cloud-llm-hub-staging` to confirm
  identical names before deploying.

## Migration note
After de-forking, the next `merge origin/main` into `deploy/acme-prod-stg`
must produce zero `mta.yaml` diff. Verify with `git diff origin/main -- mta.yaml`
on the stg branch == empty.
