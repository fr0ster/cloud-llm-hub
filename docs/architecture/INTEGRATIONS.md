# 🔌 Integration Examples

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

Real-world integration examples for popular tools and platforms. Copy, paste, and customize for your needs.

## Table of Contents

- [Cline (VS Code)](#cline-vs-code)
- [GitHub Actions](#github-actions)
- [GitLab CI](#gitlab-ci)
- [Jenkins](#jenkins)
- [n8n](#n8n)
- [Zapier](#zapier)
- [Make.com (Integromat)](#makecom-integromat)
- [Python Scripts](#python-scripts)
- [Node.js Applications](#nodejs-applications)
- [Bash Scripts](#bash-scripts)

---

## Cline (VS Code)

### Quick Setup

```bash
# Download setup tool
curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js

# Generate configuration
node update-cline-connection.js \
  --template cloud-destination \
  --connection sap-dev \
  --mcp-app cloud-llm-hub \
  --service-key-file mcpXsuaa=./keys/mcp-xsuaa.json \
  --service-key-file sapAbap=./keys/sap-abap.json
```

### Manual Configuration

```json
{
  "mcpServers": {
    "sap-dev": {
      "url": "https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http",
      "type": "streamableHttp",
      "description": "SAP Development System",
      "headers": {
        "Authorization": "Bearer {{ mcpXsuaa.access_token }}",
        "X-SAP-Destination": "SAP_DEV_DEST"
      }
    }
  }
}
```

**Features:**

- Automatic token refresh via service keys
- Multiple connection support
- YAML-driven configuration

**More:** See [MCP Config Update How-To](./MCP_CONFIG_UPDATE_HOWTO.md)

---

## GitHub Actions

### Complete Workflow

```yaml
name: SAP Code Analysis

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Download MCP Tool
        run: |
          curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js
          chmod +x update-cline-connection.js

      - name: Configure MCP Connection
        run: |
          node update-cline-connection.js \
            --connection sap-ci \
            --settings .github/.cline-settings.json \
            --sap-token ${{ secrets.SAP_JWT_TOKEN }} \
            --mcp-token ${{ secrets.MCP_XSUAA_TOKEN }} \
            --destination-name SAP_CI_DEST

      - name: Run Impact Analysis
        run: |
          node scripts/analyze-pr-changes.js \
            --settings .github/.cline-settings.json \
            --connection sap-ci
        env:
          MCP_ENDPOINT: ${{ secrets.MCP_ENDPOINT }}

      - name: Comment PR
        uses: actions/github-script@v7
        if: always()
        with:
          script: |
            const fs = require('fs');
            const analysis = fs.readFileSync('analysis-report.md', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: analysis
            });
```

### Secrets Required

- `SAP_JWT_TOKEN` - SAP system authentication token
- `MCP_XSUAA_TOKEN` - Cloud LLM Hub XSUAA token
- `MCP_ENDPOINT` - Your Cloud LLM Hub URL

---

## GitLab CI

### `.gitlab-ci.yml` Example

```yaml
stages:
  - analyze
  - deploy

variables:
  NODE_VERSION: '20'

sap-analysis:
  stage: analyze
  image: node:${NODE_VERSION}
  before_script:
    - curl -O https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js
    - chmod +x update-cline-connection.js
  script:
    - |
      node update-cline-connection.js \
        --connection sap-ci \
        --settings .gitlab/.cline-settings.json \
        --sap-token $SAP_JWT_TOKEN \
        --mcp-token $MCP_XSUAA_TOKEN
    - node scripts/validate-changes.js
  only:
    - merge_requests
  variables:
    SAP_JWT_TOKEN: $SAP_JWT_TOKEN
    MCP_XSUAA_TOKEN: $MCP_XSUAA_TOKEN
```

### GitLab Variables

Set in Settings → CI/CD → Variables:

- `SAP_JWT_TOKEN` (masked)
- `MCP_XSUAA_TOKEN` (masked)

---

## Jenkins

### Jenkinsfile (Declarative Pipeline)

```groovy
pipeline {
    agent any

    environment {
        MCP_TOOL = 'https://raw.githubusercontent.com/fr0ster/cloud-llm-hub/main/tools/update-cline-connection.js'
    }

    stages {
        stage('Setup') {
            steps {
                sh '''
                    curl -O ${MCP_TOOL}
                    chmod +x update-cline-connection.js
                '''
            }
        }

        stage('Configure MCP') {
            steps {
                withCredentials([
                    string(credentialsId: 'sap-jwt-token', variable: 'SAP_JWT_TOKEN'),
                    string(credentialsId: 'mcp-xsuaa-token', variable: 'MCP_XSUAA_TOKEN')
                ]) {
                    sh '''
                        node update-cline-connection.js \
                          --connection sap-jenkins \
                          --settings .jenkins/.cline-settings.json \
                          --sap-token ${SAP_JWT_TOKEN} \
                          --mcp-token ${MCP_XSUAA_TOKEN}
                    '''
                }
            }
        }

        stage('Analyze') {
            steps {
                sh 'node scripts/analyze-changes.js'
            }
        }
    }

    post {
        always {
            archiveArtifacts artifacts: 'analysis-report.md', allowEmptyArchive: true
        }
    }
}
```

---

## n8n

### Workflow Setup

1. **HTTP Request Node** (MCP Call):
   - **Method:** POST
   - **URL:** `https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http`
   - **Headers:**
     ```json
     {
       "Authorization": "Bearer {{ $env.MCP_XSUAA_TOKEN }}",
       "X-SAP-Destination": "{{ $json.destination }}",
       "Content-Type": "application/json"
     }
     ```
   - **Body:**
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tools/call",
       "params": {
         "name": "{{ $json.tool }}",
         "arguments": {{ $json.arguments }}
       }
     }
     ```

2. **Example Workflow:**
   ```
   Webhook → Set Variables → HTTP Request (MCP) →
   Parse Response → Filter → Send Email
   ```

### n8n JSON Template

```json
{
  "name": "SAP Code Analysis",
  "nodes": [
    {
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "parameters": {
        "path": "sap-analysis",
        "httpMethod": "POST"
      }
    },
    {
      "name": "MCP Call",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "method": "POST",
        "url": "https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "Bearer {{ $env.MCP_XSUAA_TOKEN }}"
            },
            {
              "name": "X-SAP-Destination",
              "value": "SAP_DEV_DEST"
            }
          ]
        },
        "sendBody": true,
        "bodyParameters": {
          "parameters": [
            {
              "name": "jsonrpc",
              "value": "2.0"
            },
            {
              "name": "id",
              "value": "1"
            },
            {
              "name": "method",
              "value": "tools/call"
            },
            {
              "name": "params",
              "value": "={{ { name: $json.tool, arguments: $json.arguments } }}"
            }
          ]
        }
      }
    }
  ]
}
```

---

## Zapier

### Zap Configuration

1. **Trigger:** Webhook, Schedule, or App Event
2. **Action:** Code by Zapier (Python)

```python
import requests
import json

# MCP endpoint
url = "https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http"

# Headers
headers = {
    "Authorization": f"Bearer {input_data['mcp_token']}",
    "X-SAP-Destination": input_data['sap_destination'],
    "Content-Type": "application/json"
}

# MCP request
payload = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
        "name": input_data['tool_name'],
        "arguments": json.loads(input_data['arguments'])
    }
}

# Make request
response = requests.post(url, headers=headers, json=payload)
result = response.json()

return {"result": result.get("result"), "status": response.status_code}
```

3. **Output:** Process result and trigger next action

---

## Make.com (Integromat)

### Scenario Setup

1. **HTTP Module** (Make a Request):
   - **URL:** `https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http`
   - **Method:** POST
   - **Headers:**
     ```
     Authorization: Bearer {{1.token}}
     X-SAP-Destination: {{1.destination}}
     Content-Type: application/json
     ```
   - **Body:**
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tools/call",
       "params": {
         "name": "{{1.tool}}",
         "arguments": {{1.arguments}}
       }
     }
     ```

2. **Data Structure:**
   ```json
   {
     "token": "YOUR_MCP_TOKEN",
     "destination": "SAP_DEV_DEST",
     "tool": "GetObjectList",
     "arguments": {
       "objectType": "CLAS",
       "package": "Z_MY_PACKAGE"
     }
   }
   ```

---

## Python Scripts

### Complete Example

```python
#!/usr/bin/env python3
"""
Example: Query SAP ABAP objects via Cloud LLM Hub MCP
"""

import requests
import json
import os
from typing import Dict, Any

class MCPClient:
    def __init__(self, endpoint: str, mcp_token: str, sap_destination: str):
        self.endpoint = endpoint
        self.headers = {
            "Authorization": f"Bearer {mcp_token}",
            "X-SAP-Destination": sap_destination,
            "Content-Type": "application/json"
        }

    def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Call an MCP tool"""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }

        response = requests.post(
            self.endpoint,
            headers=self.headers,
            json=payload,
            timeout=60
        )
        response.raise_for_status()
        return response.json()

    def get_object_list(self, object_type: str, package: str = None) -> Dict[str, Any]:
        """Get list of ABAP objects"""
        args = {"objectType": object_type}
        if package:
            args["package"] = package
        return self.call_tool("GetObjectList", args)

# Usage
if __name__ == "__main__":
    client = MCPClient(
        endpoint=os.getenv("MCP_ENDPOINT", "https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http"),
        mcp_token=os.getenv("MCP_XSUAA_TOKEN"),
        sap_destination=os.getenv("SAP_DESTINATION", "SAP_DEV_DEST")
    )

    # Get all classes in package
    result = client.get_object_list("CLAS", package="Z_MY_PACKAGE")
    print(json.dumps(result, indent=2))
```

### Requirements

```txt
requests>=2.31.0
```

---

## Node.js Applications

### Complete Example

```javascript
#!/usr/bin/env node
/**
 * Example: Query SAP ABAP objects via Cloud LLM Hub MCP
 */

const https = require('https');

class MCPClient {
  constructor(endpoint, mcpToken, sapDestination) {
    this.endpoint = new URL(endpoint);
    this.headers = {
      Authorization: `Bearer ${mcpToken}`,
      'X-SAP-Destination': sapDestination,
      'Content-Type': 'application/json',
    };
  }

  async callTool(toolName, arguments_) {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: arguments_,
      },
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.endpoint.hostname,
          port: this.endpoint.port || 443,
          path: this.endpoint.pathname,
          method: 'POST',
          headers: {
            ...this.headers,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse response: ${e.message}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async getObjectList(objectType, packageName = null) {
    const args = { objectType };
    if (packageName) {
      args.package = packageName;
    }
    return this.callTool('GetObjectList', args);
  }
}

// Usage
(async () => {
  const client = new MCPClient(
    process.env.MCP_ENDPOINT || 'https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http',
    process.env.MCP_XSUAA_TOKEN,
    process.env.SAP_DESTINATION || 'SAP_DEV_DEST'
  );

  try {
    const result = await client.getObjectList('CLAS', 'Z_MY_PACKAGE');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
})();
```

---

## Bash Scripts

### Simple Example

```bash
#!/bin/bash
# Example: Query SAP ABAP objects via Cloud LLM Hub MCP

MCP_ENDPOINT="${MCP_ENDPOINT:-https://your-app.cfapps.eu10.hana.ondemand.com/mcp/stream/http}"
MCP_TOKEN="${MCP_XSUAA_TOKEN}"
SAP_DEST="${SAP_DESTINATION:-SAP_DEV_DEST}"

# MCP request payload
PAYLOAD=$(cat <<EOF
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "GetObjectList",
    "arguments": {
      "objectType": "CLAS",
      "package": "Z_MY_PACKAGE"
    }
  }
}
EOF
)

# Make request
RESPONSE=$(curl -s -X POST "$MCP_ENDPOINT" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "X-SAP-Destination: $SAP_DEST" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Parse and display result
echo "$RESPONSE" | jq '.result'
```

### Usage

```bash
export MCP_XSUAA_TOKEN="your-token"
export SAP_DESTINATION="SAP_DEV_DEST"
./query-sap.sh
```

---

## 🎯 Quick Reference

### Endpoints

- **SSE:** `GET /mcp/stream/sse`
- **Stream-HTTP:** `POST /mcp/stream/http`
- **Health:** `GET /odata/v4/mcp/Health()`
- **Probe:** `GET /odata/v4/mcp/ProbeDestination?destination=NAME`

### Required Headers

- `Authorization: Bearer <XSUAA_TOKEN>` - MCP proxy authentication
- `X-SAP-Destination: <DESTINATION_NAME>` - SAP destination (for destination mode)
- OR `X-SAP-URL: <SAP_URL>` - Direct SAP URL (for direct mode)

### MCP Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "ToolName",
    "arguments": {}
  }
}
```

### Common Tools

- `GetObjectList` - List ABAP objects
- `GetObjectDetails` - Get object details
- `GetObjectSource` - Get source code
- `GetDependencies` - Get dependencies
- `GetWhereUsed` - Find where used
- `GetEnhancements` - List enhancements

**Full list:** See [submodules/mcp-abap-adt/README.md](../submodules/mcp-abap-adt/README.md)

---

## 📚 Next Steps

- **Configuration:** See [MCP Config Update How-To](./MCP_CONFIG_UPDATE_HOWTO.md)
- **API Details:** See [MCP Proxy Usage](./MCP_PROXY_USAGE.md)
- **Templates:** Check [templates/mcp-config/](./templates/mcp-config/)

---

Need help? Open an issue or check the documentation!
