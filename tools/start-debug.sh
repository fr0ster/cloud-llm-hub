#!/bin/bash
# Start CAP server with debug logging for JWT authentication debugging
# Usage: ./tools/start-debug.sh

cd "$(dirname "$0")/.." || exit 1

export CDS_LOG_LEVEL=debug
export DEBUG_CONNECTORS=true
export DEBUG_HANDLERS=true
export DEBUG_CONNECTION_MANAGER=true

echo "Starting CAP server with debug logging..."
echo "Logs will be written to: /tmp/cds-watch.log"
echo ""
echo "Debug flags enabled:"
echo "  - CDS_LOG_LEVEL=debug"
echo "  - DEBUG_CONNECTORS=true"
echo "  - DEBUG_HANDLERS=true"
echo "  - DEBUG_CONNECTION_MANAGER=true"
echo ""
echo "Server will start on: http://localhost:4004"
echo "Press Ctrl+C to stop"
echo ""

npx cds watch --with-mocks --in-memory --profile development 2>&1 | tee /tmp/cds-watch.log

