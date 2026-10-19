#!/usr/bin/env bash
# Deploy the shared RAG tables (RAG_DOCUMENTS, RAG_COLLECTIONS) of
# @mcp-abap-adt/hana-vector-rag into an existing HDI container, through a
# throwaway @sap/hdi-deploy app. Needs: cf (logged in, target space set) and npm.
#
#   tools/deploy-hdi-tables.sh [hdi-service-name]     (default: hdi-llm)
#   tools/deploy-hdi-tables.sh --dry-run [hdi-service-name]
#
# --dry-run prints what would be run and touches neither cf nor the network.
# Exits non-zero when the deployment fails or does not finish in 5 minutes.
set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi
SERVICE="${1:-hdi-llm}"
APP="cloud-llm-hub-hdi-deployer"
POLL_TIMEOUT=300   # seconds to wait for "Deployment to container ... done"
POLL_STEP=10

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/tools/hdi-deployer"
DDL="$ROOT/node_modules/@mcp-abap-adt/hana-vector-rag/ddl"
FILES=(.hdiconfig RAG_DOCUMENTS.hdbtable RAG_COLLECTIONS.hdbtable)

run() {
  if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi
}

if [ "$DRY_RUN" = 0 ]; then
  for f in "${FILES[@]}"; do
    [ -f "$DDL/$f" ] || { echo "Missing $DDL/$f - run npm ci first" >&2; exit 1; }
  done
fi

# Work in a temp copy so the repository stays clean.
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
cp "$TEMPLATE/package.json" "$TEMPLATE/manifest.yml" "$WORK/"
mkdir -p "$WORK/src"
for f in "${FILES[@]}"; do
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] cp $DDL/$f -> src/$f"
  else
    cp "$DDL/$f" "$WORK/src/$f"
  fi
done

delete_app() {
  # An unbind can still be in progress right after the deployer stops: retry.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if run cf delete "$APP" -f; then return 0; fi
    echo "cf delete $APP failed (attempt $i), retrying in 10 s..." >&2
    [ "$DRY_RUN" = 1 ] || sleep 10
  done
  echo "Could not delete $APP - delete it by hand: cf delete $APP -f" >&2
  return 1
}

RESULT=1
if (cd "$WORK" && run cf push -f manifest.yml --var "app_name=$APP" --var "hdi_service=$SERVICE"); then
  waited=0
  while [ "$waited" -lt "$POLL_TIMEOUT" ]; do
    if [ "$DRY_RUN" = 1 ]; then
      echo "[dry-run] cf logs $APP --recent | grep 'Deployment to container .* done' (every ${POLL_STEP} s, up to ${POLL_TIMEOUT} s)"
      RESULT=0
      break
    fi
    LOGS="$(cf logs "$APP" --recent 2>&1 || true)"
    if printf '%s\n' "$LOGS" | grep -Eq 'Deployment to container .* done'; then
      echo "HDI tables deployed into the container bound through '$SERVICE'."
      RESULT=0
      break
    fi
    if printf '%s\n' "$LOGS" | grep -Eq 'Deployment to container .* failed|ERR .*hdi-deploy'; then
      echo "HDI deployment reported an error:" >&2
      printf '%s\n' "$LOGS" | tail -40 >&2
      break
    fi
    sleep "$POLL_STEP"
    waited=$((waited + POLL_STEP))
  done
  if [ "$RESULT" != 0 ] && [ "$waited" -ge "$POLL_TIMEOUT" ]; then
    echo "Timed out after ${POLL_TIMEOUT} s waiting for the HDI deployment." >&2
  fi
else
  echo "cf push failed." >&2
fi

# Always remove the throwaway app so it holds no binding to the container.
delete_app || RESULT=1
exit "$RESULT"
