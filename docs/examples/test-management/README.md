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

All endpoints accept optional `model` and `temperature` to override the LLM used by cloud-llm-hub:

```bash
# Check if test exists
curl -X POST http://localhost:8080/tests/check \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19"}'

# Generate test (AI) — with model override
curl -X POST http://localhost:8080/tests/generate \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19", "requirements": "Test all public methods", "model": "anthropic--claude-4.5-sonnet"}'

# Deploy approved test
curl -X POST http://localhost:8080/tests/deploy \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19"}'

# Run test
curl -X POST http://localhost:8080/tests/run \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19"}'

# Analyze failures — with cheaper model
curl -X POST http://localhost:8080/tests/analyze \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19", "model": "gpt-4.1-mini", "failures": [{"method": "test_empty", "message": "assertion failed"}]}'
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

## Authentication

The service uses XSUAA (OAuth 2.0) with Basic-to-Bearer middleware. Two authentication methods are available.

### What you receive from the admin

The admin creates a service key and gives you these values:

| Field | Example | Description |
|-------|---------|-------------|
| `clientid` | `sb-test-management!t12345` | OAuth client ID |
| `clientsecret` | `abc123...` | OAuth client secret |
| `url` | `https://mysubaccount.authentication.eu10.hana.ondemand.com` | Token endpoint base URL |
| `service_url` | `https://myapp.cfapps.eu10-004.hana.ondemand.com` | Service endpoint |

### Method 1: Bearer JWT (recommended)

Obtain a token via `client_credentials` grant, then pass it as a Bearer header.

**Step 1 — Get a token:**

```bash
CLIENT_ID="sb-test-management!t12345"
CLIENT_SECRET="abc123..."
TOKEN_URL="https://mysubaccount.authentication.eu10.hana.ondemand.com"

TOKEN=$(curl -s -X POST "$TOKEN_URL/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "$TOKEN"
```

The token is valid for **7 days**. After expiry, repeat this step.

**Step 2 — Call the service:**

```bash
SERVICE_URL="https://myapp.cfapps.eu10-004.hana.ondemand.com"

curl -X POST "$SERVICE_URL/tests/generate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19", "requirements": "Test all public methods"}'
```

### Method 2: Basic Auth (shortcut)

The service accepts `clientid:clientsecret` directly — the Basic-to-Bearer middleware exchanges them for a JWT automatically:

```bash
curl -X POST "$SERVICE_URL/tests/generate" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"objectName": "Z_MY_CLASS", "destination": "S4HANA_E19", "requirements": "Test all public methods"}'
```

### Optional parameters

All endpoints accept optional `model` and `temperature` fields in the request body to override the LLM used by cloud-llm-hub for that specific request. When omitted, the service uses the default model configured in cloud-llm-hub.

```json
{
  "objectName": "Z_MY_CLASS",
  "destination": "S4HANA_E19",
  "model": "anthropic--claude-4.5-sonnet",
  "temperature": 0.3
}
```

### For admins: how to create credentials

```bash
# Create service key
cf create-service-key test-management-auth consumer-key

# View credentials to share with consumer
cf service-key test-management-auth consumer-key
```

Share the `clientid`, `clientsecret`, `url`, and service URL with the consumer.
