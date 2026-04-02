# CALM Dump Analyzer

A lightweight BTP service that receives SAP Cloud ALM (CALM) Event Management alerts about ABAP runtime errors, sends them to cloud-llm-hub for analysis, and returns a structured diagnosis.

## Flow

```
SAP Cloud ALM                    This Service                cloud-llm-hub
     │                                │                           │
     │  POST /analyze                 │                           │
     │  (CALM event JSON)             │                           │
     ├───────────────────────────────►│                           │
     │                                │  Build prompt from event  │
     │                                │  POST /v1/chat/completions│
     │                                ├──────────────────────────►│
     │                                │                           │ SmartAgent pipeline:
     │                                │                           │ - ReadDump (MCP)
     │                                │                           │ - ReadClass (MCP)
     │                                │                           │ - RAG (skills, facts)
     │                                │                           │ - LLM analysis
     │                                │  JSON response            │
     │                                │◄──────────────────────────┤
     │                                │  Parse → structured JSON  │
     │  { analysis, recommendations } │                           │
     │◄───────────────────────────────┤                           │
```

## API

### POST /analyze

**Request** — CALM Event Management payload:

```json
{
  "startEvent": {
    "serviceType": "SAP S/4HANA",
    "serviceName": "E19.100",
    "eventName": "Erroneous ABAP Runtime",
    "eventSubType": "NB_EXM_SAP_S4HANA_OP_ABAP_DUMP",
    "subject": "Erroneous ABAP Runtime",
    "rating": "ERROR",
    "body": "1 exceptions collected from E19.100",
    "timestamp": "2026-03-31T19:00:34Z",
    "eventDetailsTable": {
      "columns": ["Status", "Timestamp", "Message", "User", "Runtime Error~Exception", "Program"],
      "rows": [
        ["ERROR", "2026-03-31 18:53:47", "Access using a 'ZERO' object reference is not possible.", "RSEMENOV", "OBJECTS_OBJREF_NOT_ASSIGNED~CX_SY_REF_IS_INITIAL", "Z_RS_AI_TEST"]
      ]
    }
  },
  "custom": {}
}
```

**Response:**

```json
{
  "status": "analyzed",
  "event": {
    "system": "E19.100",
    "program": "Z_RS_AI_TEST",
    "error": "OBJECTS_OBJREF_NOT_ASSIGNED",
    "exception": "CX_SY_REF_IS_INITIAL",
    "user": "RSEMENOV",
    "timestamp": "2026-03-31 18:53:47"
  },
  "analysis": {
    "rootCause": "Object reference variable is not assigned (initial) when a method or attribute is accessed on it.",
    "codeSection": "The error occurs in program Z_RS_AI_TEST where a reference variable is used before being assigned with CREATE OBJECT or by other means.",
    "severity": "medium"
  },
  "recommendations": [
    {
      "type": "fix",
      "description": "Add IF <ref> IS BOUND check before accessing the object reference"
    },
    {
      "type": "fix",
      "description": "Ensure CREATE OBJECT or factory method is called before the failing line"
    },
    {
      "type": "investigate",
      "description": "Check if the object creation is conditional and the condition was not met"
    },
    {
      "type": "oss_note",
      "description": "SAP Note 1517879 — Common causes of OBJECTS_OBJREF_NOT_ASSIGNED"
    }
  ]
}
```

## Configuration

Environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `CLOUD_LLM_HUB_URL` | cloud-llm-hub srv URL | `https://srv.cfapps.eu10.hana.ondemand.com` |
| `CLOUD_LLM_HUB_AUTH` | Auth method: `bearer` or `basic` | `bearer` |
| `CLOUD_LLM_HUB_TOKEN` | JWT token for auth | `eyJ...` |
| `SAP_DESTINATION` | BTP Destination for the ABAP system | `S4HANA_E19` |
| `PORT` | Service port | `8080` |

## How It Works

1. Service receives CALM event JSON
2. Extracts key fields: program, error type, exception, user, system
3. Constructs a prompt:
   ```
   Analyze ABAP dump in system {system}:
   - Program: {program}
   - Runtime Error: {error}
   - Exception: {exception}
   - Message: {message}
   - User: {user}

   Use MCP tools to read the dump details and source code.
   Return analysis as JSON with fields: rootCause, codeSection, severity, recommendations.
   Each recommendation has type (fix|investigate|oss_note) and description.
   ```
4. Sends prompt to cloud-llm-hub `/v1/chat/completions`
5. Parses LLM response (extracts JSON from markdown if needed)
6. Returns structured response to CALM
