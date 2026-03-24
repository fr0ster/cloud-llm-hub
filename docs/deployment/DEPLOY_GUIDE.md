# Deployment Guide

## Prerequisites

1. SAP BTP account with Cloud Foundry space
2. MTA Build Tool installed (`npm install -g mbt`)
3. Cloud Foundry CLI installed

## Setup

### 1. Create MTA Extension File

```bash
# Copy template
cp .mtaext.template .mtaext

# Edit .mtaext with your actual values
# Replace all YOUR_* placeholders
```

### 2. Configure Parameters in `.mtaext`

Edit `.mtaext` and set:

- **LLM_AGENT_MODEL**: Your LLM model name (e.g., `gpt-4o-mini`, `claude-3-5-sonnet`, `deepseek-chat`)
- **LLM_AGENT_TEMPERATURE**: Temperature (0.0 - 2.0, default: `0.7`)
- **LLM_AGENT_MAX_TOKENS**: Max tokens (default: `2000`)
- **LLM_AGENT_MCP_DESTINATION**: BTP Destination name for ABAP connection

Example:
```yaml
modules:
  - name: cloud-llm-hub-srv
    properties:
      LLM_AGENT_MODEL: "gpt-4o-mini"
      LLM_AGENT_TEMPERATURE: "0.7"
      LLM_AGENT_MAX_TOKENS: "2000"
      LLM_AGENT_MCP_DESTINATION: "DEV_ABAP_SYSTEM"
```

## Build and Deploy

### Option 1: Using npm scripts (Recommended)

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "build": "cds build && mbt build -t gen --mtar mta.tar -e .mtaext",
    "deploy": "cf deploy gen/mta.tar"
  }
}
```

Then run:

```bash
npm run build
npm run deploy
```

### Option 2: Manual commands

#### 1. Build CDS

```bash
cds build
```

#### 2. Build MTA Archive

```bash
mbt build -t gen --mtar mta.tar -e .mtaext
```

#### 3. Deploy to Cloud Foundry

```bash
cf deploy gen/mta.tar
```

## Troubleshooting

### Error: "property is not provided"

Make sure you:
1. Created `.mtaext` from template
2. Filled in all required values
3. Used `-e .mtaext` flag in `mbt build` command

### Error: "field not found in type mta.EXT"

Check that parameters are under `properties:` in the module section:

```yaml
modules:
  - name: cloud-llm-hub-srv
    properties:        # ← Important!
      LLM_AGENT_MODEL: "your-model"
```

## Files

- `.mtaext.template` - Template (committed to Git)
- `.mtaext` - Your config (NOT committed, in .gitignore)
- `mta.yaml` - MTA descriptor (committed to Git)

## Multi-Destination Support (v2.2+)

After deployment, Cloud LLM Hub automatically discovers SAP ABAP destinations from BTP Destination Service.

### How It Works

1. The **primary destination** (`LLM_AGENT_MCP_DESTINATION`) is initialized at startup — agent blocks until ready
2. All other SAP ABAP destinations are discovered automatically and vectorized in the background
3. The UI shows all destinations with live status indicators

### Discovery Heuristic

Destinations are included if they match:
- **ProxyType:** `OnPremise`
- **Authentication:** `BasicAuthentication`
- **Not excluded:** OData endpoints, `/srvd_a2x/` services, and technical names (`cloud-connector`, `connectivity`)

### Adding New Destinations

Simply create a new destination in BTP Destination Service with the criteria above. Cloud LLM Hub will discover it automatically (within 5 min cache TTL) — no redeployment needed.

### Per-Request Destination Override

Clients can switch destinations per request using the `X-SAP-Destination` header:

```bash
curl -X POST .../v1/chat/completions \
  -H "X-SAP-Destination: S4HANA_TST" \
  -H "Content-Type: application/json" \
  -d '{"messages": [...]}'
```

## Security

**Never commit `.mtaext`** — it contains sensitive configuration!

The `.mtaext` file is in `.gitignore` and will not be committed to Git.
