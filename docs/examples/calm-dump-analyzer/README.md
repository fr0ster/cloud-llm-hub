# CALM Dump Analyzer

SAP CAP service that receives SAP Cloud ALM (CALM) Event Management alerts about ABAP runtime errors, sends them to cloud-llm-hub for analysis, and returns structured diagnosis.

Deploys as a standalone CF app on BTP. Connects to cloud-llm-hub via BTP Destination.

## Flow

```
SAP Cloud ALM                    This Service (CAP)           cloud-llm-hub
     │                                │                           │
     │  POST /analyzer/AnalyzeDump    │                           │
     │  (CALM event JSON)             │                           │
     ├───────────────────────────────►│                           │
     │                                │  Build prompt from event  │
     │                                │  POST /v1/chat/completions│
     │                                │  (via BTP Destination)    │
     │                                ├──────────────────────────►│
     │                                │                           │ SmartAgent:
     │                                │                           │ - ReadDump (MCP)
     │                                │                           │ - ReadClass (MCP)
     │                                │                           │ - RAG knowledge
     │                                │                           │ - LLM analysis
     │                                │  JSON response            │
     │                                │◄──────────────────────────┤
     │  { analysis, recommendations } │                           │
     │◄───────────────────────────────┤                           │
```

## Local Development

```bash
npm install

# Set cloud-llm-hub URL for local dev
export CLOUD_LLM_HUB_URL=http://localhost:4004

cds watch

# Test
curl -s -X POST http://localhost:4004/analyzer/AnalyzeDump \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n alice: | base64)" \
  -d "{\"event\": $(cat test-payload.json | jq -c '.' | jq -Rs '.')}"
```

## Deploy to BTP

```bash
# 1. Create BTP Destination "CLOUD_LLM_HUB" pointing to cloud-llm-hub srv URL

# 2. Copy and edit .mtaext
cp .mtaext.example .mtaext
# Edit: set CLOUD_LLM_HUB_DESTINATION and SAP_DESTINATION

# 3. Build and deploy
cds build --production
npx mbt build
cf deploy mta_archives/calm-dump-analyzer_1.0.0.mtar -e .mtaext
```

## API

### POST /analyzer/AnalyzeDump

OData action. Accepts `event` parameter as JSON string (CALM event payload).
Optional `model` and `temperature` override the LLM used by cloud-llm-hub for this request.

**Request:**
```json
{
  "event": "{\"startEvent\":{\"serviceName\":\"E19.100\",\"eventDetailsTable\":{...}}}",
  "model": "gpt-4.1-mini",
  "temperature": 0.3
}
```

**Response:**
```json
{
  "status": "analyzed",
  "system": "E19.100",
  "program": "Z_RS_AI_TEST",
  "error": "OBJECTS_OBJREF_NOT_ASSIGNED",
  "exception": "CX_SY_REF_IS_INITIAL",
  "user": "RSEMENOV",
  "rootCause": "Object reference variable is not assigned when accessed.",
  "codeSection": "Program Z_RS_AI_TEST accesses a reference before CREATE OBJECT.",
  "severity": "medium",
  "recommendations": "[{\"type\":\"fix\",\"description\":\"Add IS BOUND check\"}]"
}
```

## Configuration

| Variable | Description | Where |
|----------|-------------|-------|
| `CLOUD_LLM_HUB_DESTINATION` | BTP Destination name for cloud-llm-hub | `.mtaext` |
| `CLOUD_LLM_HUB_URL` | Direct URL (local dev only) | env var |
| `SAP_DESTINATION` | ABAP system destination (passed to cloud-llm-hub) | `.mtaext` |

### Per-Request LLM Overrides

Both `/analyzer/AnalyzeDump` (OData) and `/analyze` (REST) accept optional LLM parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Override LLM model (e.g., `gpt-4.1-mini`, `anthropic--claude-4.5-sonnet`) |
| `temperature` | number | Override temperature (0.0–2.0) |

When omitted, cloud-llm-hub uses its configured default model.

## Project Structure

```
calm-dump-analyzer/
├── server.js                   # REST /analyze endpoint + Basic→Bearer auth
├── srv/
│   ├── analyze.js              # Core analysis logic (prompt, LLM call, JSON extraction)
│   ├── analyzer-service.cds    # OData service definition
│   └── analyzer-service.js     # OData action handler
├── mta.yaml                    # MTA deployment descriptor
├── xs-security.json            # XSUAA config
├── .mtaext.example             # Deployment parameters template
├── test-payload.json           # Sample CALM event for testing
└── package.json
```
