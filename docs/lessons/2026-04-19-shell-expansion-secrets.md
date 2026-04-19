---
date: 2026-04-19
branch: feat/consumer-xsuaa-instances
subaccount: epam-sap-mcp-450kjhsb
space: dev
tags: [shell, secrets, xsuaa, deploy]
---

# Shell expansion corrupts xsuaa secrets containing `$`

## What went wrong

Hit this twice in one session:

1. **AICORE_CLIENT_SECRET** — initially working via `cf set-env` called from a properly-quoted shell (single quotes preserved `$v...`), but propagated confusion when looking at `.env` file values that appeared shorter than expected at first glance.

2. **CLOUD_LLM_HUB_CLIENT_SECRET** in `.mtaext` — wrote the file via bash heredoc with `${CLOUD_LLM_HUB_CLIENT_SECRET}` interpolation, where the variable value `fe0ed083-...$r2U8Kkh...` itself contained `$r2U8Kkh`. Bash interpreted `$r2U8Kkh` as a nested variable (undefined → empty string), so the written value ended with `fe0ed083-b396-4cdc-9ff2-1ab0c72202b8=` — silently truncated at the `$`. BTP Destination service stored the corrupted value; token fetches failed with "Bad credentials"; `calm-dump-analyzer` `AnalyzeDump` call returned "Failed to build headers".

## Why

xsuaa generates `binding-secret` values in the format `<uuid>$<base64>=`. The `$` sits in the middle of the secret and is interpreted by any shell with unquoted or double-quoted interpolation. Even inside heredocs (`cat <<EOF` without `'EOF'`), variable expansion is active.

Affected tooling in this repo:
- `cf set-env FOO "$VALUE"` (double-quoted — expansion happens, can truncate)
- `.mtaext` written via `cat <<EOF ... ${VAR} ... EOF` (heredoc without quoted delimiter)
- Any script that reads secrets from one place and pastes into another via shell variables

## Fix

**Immediate:** rewrote `.mtaext` using Node to extract the secret from the JSON service key and serialize via `JSON.stringify` (which produces a YAML-compatible double-quoted string with no shell involvement):

```bash
cf service-key cloud-llm-hub-analyst-consumer analyst-key | sed -n '/^{/,/^}/p' > /tmp/key.json

SRV=... node <<'NODE' > .mtaext
const k = JSON.parse(require('fs').readFileSync('/tmp/key.json')).credentials;
const lines = [
  "_schema-version: '3.3.0'",
  ...
  `  CLOUD_LLM_HUB_CLIENT_SECRET: ${JSON.stringify(k.clientsecret)}`,
  ...
];
process.stdout.write(lines.join('\n') + '\n');
NODE
```

`JSON.stringify` produces `"fe0ed083-...$r2U8Kkh...="` verbatim; Node's output is piped to the file, no shell touches the value.

**For `cf set-env`:** always use single quotes around `$VALUE` OR pass via `cf set-env APP VAR "$(cat file-with-raw-secret)"` where `file-with-raw-secret` was written via Node/Python (same discipline).

## Prevention rule

- **Never pass xsuaa / aicore secrets through shell variable interpolation.** Always use one of:
  1. Node/Python script that reads JSON service-key and writes the destination file in one step (no intermediate shell variable).
  2. `cf set-env APP VAR 'literal-value-in-single-quotes'` when typing manually.
  3. File-backed passthrough: write raw value to a file via a non-shell tool, then `cf set-env APP VAR "$(cat file)"` (only quote safely because the file contents don't interpolate).
- Before declaring a deploy/rotation complete, read the deployed value back (`cf env <app> | grep SECRET`, or fetch the destination config from destination-configuration API) and string-compare against the source. Any prefix match without exact equality = corruption.
- Consider a tool script (`tools/write-mtaext-from-service-key.js`) that codifies the safe pattern for the deploy flow of examples.
