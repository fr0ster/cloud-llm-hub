#!/usr/bin/env bash
# Deploy cloud-llm-hub from a deploy/* worktree.
#
# Prerequisites:
#   1. cf login to the correct subaccount
#   2. cd to the deployment checkout (the branch that carries this subaccount's .mtaext)
#   3. .env with AICORE_* secrets (if no AI Core binding in this subaccount)
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
# Secrets not in mta.yaml properties — cf set-env values persist through deploy
echo ""
echo "[2/4] Secrets..."
if [ -f .env ]; then
  SRV_APP_RESOLVED="$SRV_APP"
  python3 - "$SRV_APP_RESOLVED" << 'PYEOF'
import subprocess, sys

srv = sys.argv[1]
env = {}
with open('.env') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()

if not env:
    print('  No vars in .env')
    sys.exit(0)

for k, v in env.items():
    r = subprocess.run(['cf', 'set-env', srv, k, v], capture_output=True, text=True)
    status = 'OK' if r.returncode == 0 else 'FAIL'
    display = v[:8] + '...' if len(v) > 12 else v
    print(f'  {k}={display} : {status}')
PYEOF
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
npx mbt build $MTA_FLAG 2>&1 | tail -3

# Deploy (app restarts automatically — no separate restart needed)
MTAR=$(ls -t mta_archives/*.mtar 2>/dev/null | head -1)
echo ""
echo "[4/4] Deploy $MTAR..."
cf deploy "$MTAR" -e "$MTAEXT"

echo ""
echo "=== Done: $BRANCH ==="
