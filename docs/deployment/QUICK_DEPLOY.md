# Quick Deploy Guide

## Prerequisites

- `.mtaext` file created and configured (see `DEPLOY_GUIDE.md`)
- Cloud Foundry CLI logged in: `cf login`

## Deploy Commands

### Full build and deploy

```bash
# 1. Build the MTA archive (mta.yaml's before-all already runs cds build)
npm run build:mta

# 2. Deploy to CF
npm run deploy
```

These scripts already exist in `package.json`; there is nothing to add. They produce
`gen/mta_archives/cloud-llm-hub.mtar` and deploy it with `-e .mtaext`.

## Quick Setup

1. **Create `.mtaext`** from template:
   ```bash
   cp docs/deployment/templates/mcp-sap-ai-core.mtaext.template .mtaext
   ```

2. **Edit `.mtaext`** - replace `YOUR_*` values:
   - `LLM_AGENT_MODEL`: e.g., `"gpt-4o-mini"`
   - `LLM_AGENT_MCP_DESTINATION`: e.g., `"DEV_ABAP"`

3. **Build and deploy**:
   ```bash
   npm run build && npm run build:mta
   npm run deploy
   ```

## Files

- `docs/deployment/templates/*.mtaext.template` - Templates, one per scenario (in Git)
- `.mtaext` - Your config (NOT in Git, in .gitignore)
- `mta.yaml` - MTA descriptor
- `DEPLOY_GUIDE.md` - Full deployment guide

## Common Issues

**Error: "property is not provided"**
- Make sure `.mtaext` exists and has real values (not `YOUR_*`)
- Check that you use `-e .mtaext` flag

**Error: "field not found"**
- `.mtaext` must have `parameters:` at global level, not in modules
