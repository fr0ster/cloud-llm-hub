# Consumer Guide

How to call the CALM Dump Analyzer from external systems.

## OData Endpoint

```
POST /odata/v4/analyzer/AnalyzeDump
Content-Type: application/json
```

The `event` parameter is a JSON string containing the CALM event payload.

## Request Format

```json
{
  "event": "<CALM event JSON as escaped string>",
  "model": "gpt-4.1-mini",
  "temperature": 0.3
}
```

The `event` value must be a JSON-encoded string (escaped). This is required by OData action parameter typing.

The `model` and `temperature` parameters are **optional** — they override the LLM model and temperature used by cloud-llm-hub for this specific request. When omitted, the service uses the default model configured in cloud-llm-hub.

### Building the Request

**From CALM webhook (JavaScript):**
```javascript
const calmEvent = { startEvent: { ... } };

const response = await fetch('https://<service>/odata/v4/analyzer/AnalyzeDump', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer <token>',
  },
  body: JSON.stringify({
    event: JSON.stringify(calmEvent),
  }),
});

const result = await response.json();
```

**From curl:**
```bash
curl -X POST https://<service>/odata/v4/analyzer/AnalyzeDump \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"event\": $(cat calm-event.json | jq -c '.' | jq -Rs '.')}"
```

**From SAP Integration Suite (iFlow):**
- HTTP Receiver adapter
- POST to `/odata/v4/analyzer/AnalyzeDump`
- Content-Type: `application/json`
- Body: use Content Modifier to wrap CALM payload in `{"event": "<escaped>"}`

**From ABAP (CL_HTTP_CLIENT):**
```abap
DATA(lv_event) = /ui2/cl_json=>serialize( calm_event ).
DATA(lv_body) = |{  "event": "{ escape( val = lv_event format = cl_abap_format=>e_json_string ) }" }|.
```

## Response Format

### Successful Analysis

```json
{
  "status": "analyzed",
  "system": "E19.100",
  "program": "Z_RS_AI_TEST",
  "error": "OBJECTS_OBJREF_NOT_ASSIGNED",
  "exception": "CX_SY_REF_IS_INITIAL",
  "user": "RSEMENOV",
  "rootCause": "Object reference variable is not assigned when a method is called on it.",
  "codeSection": "Line 42 in Z_RS_AI_TEST calls lo_object->method() but lo_object was never created.",
  "severity": "medium",
  "recommendations": "[{\"type\":\"fix\",\"description\":\"Add IS BOUND check\"},{\"type\":\"oss_note\",\"description\":\"SAP Note 1517879\"}]",
  "errorMessage": ""
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `analyzed` or `error` |
| `system` | string | SAP system ID (e.g., `E19.100`) |
| `program` | string | ABAP program name |
| `error` | string | Runtime error type (e.g., `OBJECTS_OBJREF_NOT_ASSIGNED`) |
| `exception` | string | Exception class (e.g., `CX_SY_REF_IS_INITIAL`) |
| `user` | string | User who caused the dump |
| `rootCause` | string | AI analysis of the root cause |
| `codeSection` | string | Description of the problematic code area |
| `severity` | string | `low`, `medium`, `high`, or `critical` |
| `recommendations` | string | JSON array of `{ type, description }` objects |
| `errorMessage` | string | Error details if `status` is `error` |

### Parsing Recommendations

The `recommendations` field is a JSON string (OData limitation for complex arrays). Parse it on the consumer side:

```javascript
const recommendations = JSON.parse(result.recommendations);
// [
//   { "type": "fix", "description": "Add IS BOUND check before accessing reference" },
//   { "type": "investigate", "description": "Check if CREATE OBJECT is conditional" },
//   { "type": "oss_note", "description": "SAP Note 1517879" }
// ]
```

Recommendation types:
- `fix` — concrete code fix suggestion
- `investigate` — area to look into further
- `oss_note` — relevant SAP Note

### Error Response

```json
{
  "status": "error",
  "system": "E19.100",
  "program": "Z_RS_AI_TEST",
  "error": "OBJECTS_OBJREF_NOT_ASSIGNED",
  "exception": "CX_SY_REF_IS_INITIAL",
  "user": "RSEMENOV",
  "rootCause": "",
  "codeSection": "",
  "severity": "",
  "recommendations": "[]",
  "errorMessage": "cloud-llm-hub returned 503"
}
```

Even on error, the parsed event fields are still populated so the consumer can identify which dump failed analysis.

## Authentication

The service uses XSUAA (OAuth 2.0). You need credentials from the service admin to authenticate.

### What you receive from the admin

The admin creates a service key and gives you these values:

| Field | Example | Description |
|-------|---------|-------------|
| `clientid` | `sb-calm-dump-analyzer!t12345` | OAuth client ID |
| `clientsecret` | `abc123...` | OAuth client secret |
| `url` | `https://mysubaccount.authentication.eu10.hana.ondemand.com` | Token endpoint base URL |
| `service_url` | `https://myapp.cfapps.eu10-004.hana.ondemand.com` | Service endpoint |

### Step 1: Get an API token

Exchange your credentials for a JWT token:

```bash
# Set your credentials (from the admin)
CLIENT_ID="sb-calm-dump-analyzer!t12345"
CLIENT_SECRET="abc123..."
TOKEN_URL="https://mysubaccount.authentication.eu10.hana.ondemand.com"

# Get token
TOKEN=$(curl -s -X POST "$TOKEN_URL/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "$TOKEN"
```

The token is valid for **7 days**. After expiry, repeat this step.

### Step 2: Call the service

**With Bearer token (recommended):**
```bash
SERVICE_URL="https://myapp.cfapps.eu10-004.hana.ondemand.com"

curl -X POST "$SERVICE_URL/odata/v4/analyzer/AnalyzeDump" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event": "..."}'
```

**With Basic Auth (shortcut):**

The service also accepts `clientid:clientsecret` directly — it exchanges them for a JWT automatically:

```bash
curl -X POST "$SERVICE_URL/odata/v4/analyzer/AnalyzeDump" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"event": "..."}'
```

### For admins: how to create credentials

```bash
# Create service key
cf create-service-key calm-dump-analyzer-auth consumer-key

# View credentials to share with consumer
cf service-key calm-dump-analyzer-auth consumer-key
```

Share the `clientid`, `clientsecret`, `url`, and service URL with the consumer.

## Health Check

```
GET /analyzer/Health()
```

Returns:
```json
{
  "status": "ok",
  "llmHubUrl": "destination:CLOUD_LLM_HUB",
  "timestamp": "2026-04-02T12:00:00Z"
}
```
