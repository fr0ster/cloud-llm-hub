# Quick Hybrid Debugging Setup

## 🚀 Quick Start

### 1. Deploy to BTP

```bash
# Build and deploy
npx mbt build
cf deploy gen/mta_archives/cloud-llm-hub_*.mtar
```

### 2. Download Environment Variables

```bash
# Download VCAP_SERVICES from BTP
npm run update:env
```

This updates `default-env.json` with:
- XSUAA service binding
- Destination service binding
- **SAP AI Core service binding** (for LLM endpoints)
- Connectivity service binding

### 3. Start Hybrid Debugging

**VS Code:**
1. Press `F5`
2. Select "cds watch (Hybrid - Local + Cloud Services)"
3. Set breakpoints in `srv/agent-service.ts`

**Or manually:**
```bash
NODE_OPTIONS="--inspect=9229" npx cds watch --profile production
```

### 4. Test Cloud-Only Endpoints

```bash
# Test Agent Health
curl -X GET "http://localhost:4004/odata/v4/agent/Health()" \
  -H "Authorization: Basic YWxpY2U6" | jq

# Test Agent Chat (uses SAP AI Core)
curl -X POST "http://localhost:4004/odata/v4/agent/Chat" \
  -H "Authorization: Basic YWxpY2U6" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}' | jq
```

## ✅ Verification Checklist

- [ ] `default-env.json` contains `VCAP_SERVICES.aicore[0]`
- [ ] SAP AI Core service has `credentials.clientid` and `credentials.clientsecret`
- [ ] SAP AI Core service has `credentials.serviceurls.AI_API_URL`
- [ ] VS Code launch.json has "cds watch (Hybrid - Local + Cloud Services)" config
- [ ] Server starts on `http://localhost:4004`
- [ ] Breakpoints work in VS Code

## 📚 Full Documentation

See `docs/development/HYBRID_DEBUG_SETUP.md` for detailed guide.
