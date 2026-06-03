#!/usr/bin/env node
/**
 * Generate the staging MTA descriptor (and its xs-security JSONs) from the prod
 * mta.yaml, so the staging branch never has to fork mta.yaml.
 *
 * Reads ./mta.yaml, renames the structural identifiers from `cloud-llm-hub`
 * to `cloud-llm-hub-staging` (MTA ID, module/resource names, provides/requires
 * references, xsappname, TENANT_HOST_PATTERN), and writes the result to
 * ./mta.staging.generated.yaml (gitignored, ephemeral).
 *
 * Every xs-security*.json a resource references via `path:` is also regenerated
 * to ./xs-security*.generated.json with the SAME rename applied (xsappname,
 * grant-as-authority-to-apps, authorities) — otherwise the staging XSUAA apps
 * would carry prod app IDs and the analyst/developer grant flow would break or
 * authorize against prod. The generated descriptor's `path:` values are
 * rewritten to point at those generated JSONs.
 *
 * What it does NOT change:
 * - the `route:` template (host is set by .mtaext.staging via APPROUTER_HOST)
 * - APPROUTER_HOST / CF_LANDSCAPE / LLM_AGENT_* / DESTINATION_MAPPING params
 * - the version number (stays == prod, from package.json sync)
 * - the `{space-guid}` / `!t<id>` tenant suffixes (staging shares the space)
 *
 * The rename is idempotent: a token already followed by `-staging` is left
 * alone, so re-running on a generated file does not produce `-staging-staging`.
 *
 * Run from the project root (or any dir containing mta.yaml):
 *   node tools/make-staging-mta.js
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Replace the bare token `cloud-llm-hub` with `cloud-llm-hub-staging` when it
// is NOT already followed by `-staging`. Negative lookahead guards idempotency.
function toStaging(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/cloud-llm-hub(?!-staging)/g, 'cloud-llm-hub-staging');
}

// Deep-rename every string in a parsed JSON value (xs-security descriptor).
// Safe for xsappname, grant-as-authority-to-apps[], authorities[], scope/role
// names — they all only contain the `cloud-llm-hub` token plus tenant suffixes
// (`{space-guid}`, `!t<id>`) which toStaging leaves intact.
function deepRename(node) {
  if (typeof node === 'string') return toStaging(node);
  if (Array.isArray(node)) return node.map(deepRename);
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = deepRename(node[k]);
    return node;
  }
  return node;
}

// Suffix every role-collection name so staging gets its own collections.
// Role-collection names are subaccount-GLOBAL (not scoped by xsappname), so a
// staging deploy into the same subaccount as prod would collide on create
// ("Role Collection X already exists") unless the names differ. The names carry
// no `cloud-llm-hub` token, so deepRename leaves them untouched — handle here.
// Idempotent: a name already ending in the suffix is left alone.
const ROLE_COLLECTION_SUFFIX = ' (staging)';
function renameRoleCollections(sec) {
  const collections = sec && sec['role-collections'];
  if (!Array.isArray(collections)) return;
  for (const rc of collections) {
    if (
      rc &&
      typeof rc.name === 'string' &&
      !rc.name.endsWith(ROLE_COLLECTION_SUFFIX)
    ) {
      rc.name += ROLE_COLLECTION_SUFFIX;
    }
  }
}

// Derive the generated xs-security filename: ./xs-security-foo.json ->
// ./xs-security-foo.generated.json (relative paths from the descriptor).
function generatedSecurityPath(securityPath) {
  return securityPath.replace(/\.json$/, '.generated.json');
}

// Rename structural identifiers in the MTA descriptor and, for each xsuaa
// resource, regenerate its xs-security JSON and repoint `path:` at it.
function transform(doc, root) {
  doc.ID = toStaging(doc.ID);

  for (const mod of doc.modules || []) {
    mod.name = toStaging(mod.name);
    for (const dep of mod.requires || []) dep.name = toStaging(dep.name);
    for (const prov of mod.provides || []) prov.name = toStaging(prov.name);
    const thp = mod.properties?.TENANT_HOST_PATTERN;
    if (thp) mod.properties.TENANT_HOST_PATTERN = toStaging(thp);
  }

  for (const res of doc.resources || []) {
    res.name = toStaging(res.name);
    const params = res.parameters || {};
    const cfg = params.config;
    if (cfg?.xsappname) cfg.xsappname = toStaging(cfg.xsappname);
    for (const dep of res.requires || []) dep.name = toStaging(dep.name);

    // Regenerate any referenced xs-security*.json with the rename applied,
    // then repoint the resource's path at the generated copy.
    if (
      typeof params.path === 'string' &&
      /xs-security.*\.json$/.test(params.path)
    ) {
      const srcSec = path.join(root, params.path);
      const sec = JSON.parse(fs.readFileSync(srcSec, 'utf8'));
      deepRename(sec);
      renameRoleCollections(sec);
      const outRel = generatedSecurityPath(params.path);
      fs.writeFileSync(
        path.join(root, outRel),
        `${JSON.stringify(sec, null, 2)}\n`,
      );
      params.path = outRel;
    }
  }

  return doc;
}

function main() {
  const root = process.cwd();
  const srcPath = path.join(root, 'mta.yaml');
  const outPath = path.join(root, 'mta.staging.generated.yaml');

  const doc = yaml.load(fs.readFileSync(srcPath, 'utf8'));
  transform(doc, root);

  // lineWidth: -1 prevents js-yaml from wrapping long command strings.
  const out = yaml.dump(doc, { lineWidth: -1, quotingType: '"' });
  fs.writeFileSync(outPath, out);
  console.log(`Wrote ${outPath} (ID: ${doc.ID}, version: ${doc.version})`);
}

main();
