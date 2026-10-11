#!/usr/bin/env bash
# Deploy cloud-llm-hub from a deploy/* worktree.
#
# Prerequisites:
#   1. cf login to the correct subaccount
#   2. cd to the deployment checkout (the branch that carries this subaccount's .mtaext)
#   3. .env with AICORE_* secrets (if no AI Core binding in this subaccount)
#   4. Tools: node, cf with the multiapps plugin (cf deploy), GNU make (mbt build)
#
# Usage:
#   tools/deploy.sh            # production (.mtaext)
#   tools/deploy.sh staging    # staging (.mtaext.staging)
#
# Flow: verify CF target → merge main → inject secrets → build → deploy

set -euo pipefail

STAGING="${1:-}"

# Detect mode
if [ "$STAGING" = "staging" ]; then
  echo "Generating staging MTA descriptor from mta.yaml..."
  node tools/make-staging-mta.js
  MTA_FLAG="-f mta.staging.generated.yaml"
  MTAEXT=".mtaext.staging"
  SRV_APP="cloud-llm-hub-staging-srv"
else
  MTA_FLAG=""
  MTAEXT=".mtaext"
  SRV_APP="cloud-llm-hub-srv"
fi

# Verify .mtaext
if [ ! -f "$MTAEXT" ]; then
  echo "Error: $MTAEXT not found. Are you in a deploy/* worktree?"
  exit 1
fi

BRANCH=$(git branch --show-current)
echo "=== Deploy: $BRANCH ==="

# Tools the deploy needs — fail now, not halfway through.
# Captured first: `cf plugins | grep -q` can fail under pipefail when grep
# closes the pipe early (SIGPIPE on cf).
CF_PLUGINS=$(cf plugins 2>/dev/null || true)
if [[ "$CF_PLUGINS" != *multiapps* ]]; then
  echo "Error: 'cf deploy' needs the multiapps CF CLI plugin: cf install-plugin multiapps -f"
  exit 1
fi
if ! command -v make >/dev/null 2>&1; then
  echo "Error: 'mbt build' needs GNU make on PATH (Windows: winget install ezwinports.make)"
  exit 1
fi

# Verify CF target matches deploy branch
APPROUTER_HOST=$(grep -oP 'APPROUTER_HOST:\s*"\K[^"]+' "$MTAEXT" 2>/dev/null || echo "")
# Full org string (e.g. "Acme Inc_cloud-llm-hub-abc123"); awk '{print $2}'
# used to grab only the first token ("Acme") and falsely warn.
CF_ORG=$(cf target 2>&1 | grep "^org:" | sed 's/^org:[[:space:]]*//')

echo ""
echo "CF target:"
cf target 2>&1 | grep -E "org:|space:|user:" | sed 's/^/  /'
echo "  .mtaext host: $APPROUTER_HOST"

# Check if approuter host contains a substring from the CF org
if [ -n "$APPROUTER_HOST" ] && [ -n "$CF_ORG" ]; then
  # Extract subaccount ID from approuter host (e.g., "acme-abc123" from "acme-abc123-cloud-llm-hub")
  HOST_PREFIX=$(echo "$APPROUTER_HOST" | sed 's/-cloud-llm-hub.*//')
  if echo "$CF_ORG" | grep -qi "$HOST_PREFIX"; then
    echo "  ✓ CF target matches deploy branch"
  else
    echo ""
    echo "  ✗ WARNING: CF org '$CF_ORG' may not match host '$APPROUTER_HOST'"
    echo "    Run: cf target -o <correct-org> -s dev"
    read -p "  Continue anyway? (y/n) " -n 1 -r
    echo ""
    [[ $REPLY =~ ^[Yy]$ ]] || exit 0
  fi
fi
echo ""

# Merge main (NOT rebase). These deploy/* branches carry a long history of
# merge commits from main plus a few deploy-specific commits; `git rebase main`
# replays those commits onto main and conflicts on files since deleted upstream
# (e.g. the old app/router/chat/webapp/index.html). Merge is the promotion model.
echo ""
echo "[1/4] Merge main..."
git merge --no-edit main

# Inject secrets from .env BEFORE deploy
# Secrets not in mta.yaml properties — cf set-env values persist through deploy.
# On the first deploy the app does not exist yet: set them after the deploy
# and restart, or the app starts without them.
echo ""
echo "[2/4] Secrets..."
SECRETS_AFTER_DEPLOY=""
if [ -f .env ]; then
  if cf app "$SRV_APP" --guid >/dev/null 2>&1; then
    node tools/set-env-from-dotenv.js "$SRV_APP" .env || echo "  WARNING: some variables were not set"
  else
    echo "  $SRV_APP does not exist yet — secrets go in after the deploy"
    SECRETS_AFTER_DEPLOY=1
  fi
else
  echo "  No .env — skipping secret injection"
fi

# Tool vectors are built, not computed at startup (spec §4.4). Always run the
# build step: it resolves the effective tools backend with the app's own
# config rules (legacy LLM_AGENT_RAG_TYPE and defaults included), and it
# exits without work for in-memory or when matching vectors already exist.
# Same extension file cf deploy uses (.mtaext or .mtaext.staging).
echo ""
echo "[build] Tool vectors..."
npx tsx tools/generate-tool-embeddings.ts --mtaext "$MTAEXT"

# Build
echo ""
echo "[3/4] Build..."
# Run mbt from a copy outside node_modules: mta.yaml's before-all deletes
# node_modules and runs npm ci, and Windows cannot delete the running mbt.exe
# (EPERM) — make then reports only "pre_build Error 1".
MBT_SRC=""
for f in node_modules/mbt/unpacked_bin/mbt node_modules/mbt/unpacked_bin/mbt.exe; do
  if [ -f "$f" ]; then MBT_SRC="$f"; break; fi
done
if [ -z "$MBT_SRC" ]; then
  echo "Error: mbt binary not found under node_modules/mbt — run npm install"
  exit 1
fi
MBT_DIR=$(mktemp -d)
trap 'rm -rf "$MBT_DIR"' EXIT
cp "$MBT_SRC" "$MBT_DIR/"
"$MBT_DIR/$(basename "$MBT_SRC")" build $MTA_FLAG 2>&1 | tail -3

# Deploy (app restarts automatically — no separate restart needed)
MTAR=$(ls -t mta_archives/*.mtar 2>/dev/null | head -1)
echo ""
echo "[4/4] Deploy $MTAR..."
cf deploy "$MTAR" -e "$MTAEXT"

if [ -n "$SECRETS_AFTER_DEPLOY" ]; then
  echo ""
  echo "[4/4] Secrets for the new app, then restart..."
  node tools/set-env-from-dotenv.js "$SRV_APP" .env || echo "  WARNING: some variables were not set"
  cf restart "$SRV_APP"
fi

echo ""
echo "=== Done: $BRANCH ==="
