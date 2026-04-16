#!/usr/bin/env bash
# Deploy cloud-llm-hub from a deploy/* worktree.
#
# Prerequisites:
#   1. cf login to the correct subaccount
#   2. cd to the worktree (.worktrees/ai-apps, .worktrees/acme-sandbox, etc.)
#   3. .env with AICORE_* secrets (if no AI Core binding in this subaccount)
#
# Usage:
#   cd .worktrees/ai-apps    && ../../tools/deploy.sh
#   cd .worktrees/ai-apps-stg && ../../tools/deploy.sh staging
#
# Flow: verify CF target → rebase main → inject secrets → build → deploy

set -euo pipefail

STAGING="${1:-}"

# Detect mode
if [ "$STAGING" = "staging" ]; then
  MTA_FLAG="-f mta-staging.yaml"
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
CF_ORG=$(cf target 2>&1 | grep "org:" | awk '{print $2}')

echo ""
echo "CF target:"
cf target 2>&1 | grep -E "org:|space:|user:" | sed 's/^/  /'
echo "  .mtaext host: $APPROUTER_HOST"

# Check if approuter host contains a substring from the CF org
if [ -n "$APPROUTER_HOST" ] && [ -n "$CF_ORG" ]; then
  # Extract subaccount ID from approuter host (e.g., "acme-subaccount" from host)
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

# Rebase on main
echo ""
echo "[1/4] Rebase on main..."
git rebase main

# Inject AICORE secrets from .env (if no binding)
echo ""
echo "[2/4] Secrets..."
HAS_BINDING=$(cf env "$SRV_APP" 2>/dev/null | grep -c '"aicore"' || true)

if [ "$HAS_BINDING" -gt 0 ]; then
  echo "  AI Core binding found — no injection needed"
elif [ -f .env ]; then
  echo "  No AI Core binding — injecting AICORE_* from .env..."
  python3 << 'PYEOF'
import subprocess, sys
env = {}
with open('.env') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()

aicore = {k: v for k, v in env.items() if k.startswith('AICORE_')}
if not aicore:
    print('  No AICORE_* in .env')
    sys.exit(0)

import os
srv = os.environ.get('SRV_APP', 'cloud-llm-hub-srv')
for k, v in aicore.items():
    r = subprocess.run(['cf', 'set-env', srv, k, v], capture_output=True, text=True)
    print(f'  {k}: {"OK" if r.returncode == 0 else "FAIL"}')
PYEOF
else
  echo "  Warning: no .env and no AI Core binding — models endpoint may not work"
fi

# Build
echo ""
echo "[3/4] Build..."
npx mbt build $MTA_FLAG 2>&1 | tail -3

# Deploy
MTAR=$(ls -t mta_archives/*.mtar 2>/dev/null | head -1)
echo ""
echo "[4/4] Deploy $MTAR..."
cf deploy "$MTAR" -e "$MTAEXT"

echo ""
echo "=== Done: $BRANCH ==="
