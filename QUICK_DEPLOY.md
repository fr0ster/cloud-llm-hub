# Quick Deploy Guide

## Prerequisites

- `.mtaext` file created and configured (see `DEPLOY_GUIDE.md`)
- Cloud Foundry CLI logged in: `cf login`

## Deploy Commands

### Full build and deploy

```bash
# 1. Build everything
cds build && mbt build -t gen --mtar mta.tar -e .mtaext

# 2. Deploy to CF
cf deploy gen/mta.tar
```

### Or use npm scripts

Add to `package.json`:

```json
"scripts": {
  "mta:build": "cds build && mbt build -t gen --mtar mta.tar -e .mtaext",
  "mta:deploy": "cf deploy gen/mta.tar"
}
```

Then:

```bash
npm run mta:build
npm run mta:deploy
```

## Quick Setup

1. **Create `.mtaext`** from template:
   ```bash
   cp .mtaext.template .mtaext
   ```

2. **Edit `.mtaext`** - replace `YOUR_*` values:
   - `LLM_AGENT_MODEL`: e.g., `"gpt-4o-mini"`
   - `LLM_AGENT_MCP_DESTINATION`: e.g., `"DEV_ABAP"`

3. **Build and deploy**:
   ```bash
   cds build && mbt build -t gen --mtar mta.tar -e .mtaext
   cf deploy gen/mta.tar
   ```

## Files

- `.mtaext.template` - Template (in Git)
- `.mtaext` - Your config (NOT in Git, in .gitignore)
- `mta.yaml` - MTA descriptor
- `DEPLOY_GUIDE.md` - Full deployment guide

## Common Issues

**Error: "property is not provided"**
- Make sure `.mtaext` exists and has real values (not `YOUR_*`)
- Check that you use `-e .mtaext` flag

**Error: "field not found"**
- `.mtaext` must have `parameters:` at global level, not in modules
