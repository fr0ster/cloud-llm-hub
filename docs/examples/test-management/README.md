# ABAP Unit Test Service

REST API for ABAP unit test lifecycle — check, generate (AI), deploy, run, analyze. Connects to SAP via cloud-llm-hub. Stores test mappings in SQLite.

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/tests/check` | Does test exist for object? |
| POST | `/tests/generate` | AI generates test draft |
| POST | `/tests/deploy` | Write test to SAP system |
| POST | `/tests/run` | Execute test, get results |
| POST | `/tests/analyze` | AI analyzes test failures |
| GET | `/mappings` | List all test mappings |
| GET | `/health` | Health check |

## Quick Start

```bash
npm install

# Set cloud-llm-hub destination (BTP Destination name)
# SAP_DESTINATION is passed to cloud-llm-hub as x-sap-destination

npm start
```

## Usage

```bash
# Check if test exists
curl -X POST http://localhost:8080/tests/check \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19"}'

# Generate test (AI)
curl -X POST http://localhost:8080/tests/generate \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19", "requirements": "Test all public methods"}'

# Deploy approved test
curl -X POST http://localhost:8080/tests/deploy \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19"}'

# Run test
curl -X POST http://localhost:8080/tests/run \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19"}'

# Analyze failures
curl -X POST http://localhost:8080/tests/analyze \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19", "failures": [{"method": "test_empty", "message": "assertion failed"}]}'
```

## Architecture

```
Consumer (JIRA/Jenkins/CLI)
    ↓ REST API
ABAP Unit Test Service
    ├── SQLite (mappings)
    └── cloud-llm-hub (BTP Destination)
            ├── SmartAgent + MCP
            └── SAP System (tests, results)
```

See [DESIGN.md](DESIGN.md) for full design document.
