# XSUAA User Token Authentication Setup

## Problem

By default, XSUAA service key only supports `client_credentials` grant type (service-to-service authentication). For user token authentication (browser login), you need to configure additional grant types in `xs-security.json`.

## Solution

### 1. Update xs-security.json

Add `grant-types` to `oauth2-configuration`:

```json
{
  "oauth2-configuration": {
    "redirect-uris": [...],
    "grant-types": [
      "authorization_code",  // Browser-based OAuth flow
      "password",            // Username/password (for testing)
      "client_credentials",  // Service-to-service (default)
      "refresh_token"        // Token refresh
    ],
    "token-validity": 3600,           // 1 hour
    "refresh-token-validity": 2592000 // 30 days
  }
}
```

### 2. Redeploy XSUAA Service

After updating `xs-security.json`, redeploy the MTA to update XSUAA configuration:

```bash
# Build and deploy
npx mbt build
cf deploy gen/mta_archives/cloud-llm-hub_*.mtar
```

**Important:** XSUAA service configuration is updated during deployment. The service instance will be updated with new grant types.

### 3. Get User Token

#### Option A: Authorization Code Flow (Browser - Recommended)

1. **Get authorization code:**
   ```bash
   # Open in browser
   https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/authorize?client_id=<client-id>&response_type=code&redirect_uri=http://localhost:8080/callback
   ```

2. **Login with your BTP credentials**

3. **Copy authorization code from redirect URL:**
   ```
   http://localhost:8080/callback?code=<authorization-code>
   ```

4. **Exchange code for token:**
   ```bash
   CODE="<authorization-code>"
   CLIENT_ID=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientid')
   CLIENT_SECRET=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientsecret')
   XSUAA_URL=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.url')
   
   curl -X POST "$XSUAA_URL/oauth/token" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -u "$CLIENT_ID:$CLIENT_SECRET" \
     -d "grant_type=authorization_code" \
     -d "code=$CODE" \
     -d "redirect_uri=http://localhost:8080/callback" | jq -r '.access_token'
   ```

#### Option B: Password Grant (Testing Only)

```bash
# Use the script
./tools/get-user-token.sh <username> <password>

# Or manually
CLIENT_ID=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientid')
CLIENT_SECRET=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.clientsecret')
XSUAA_URL=$(cat default-env.json | jq -r '.VCAP_SERVICES.xsuaa[0].credentials.url')

curl -X POST "$XSUAA_URL/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=password" \
  -d "username=<your-username>" \
  -d "password=<your-password>" | jq -r '.access_token'
```

**⚠️ Warning:** Password grant is less secure and should only be used for testing. Use authorization_code flow in production.

### 4. Use User Token

```bash
# Get token
TOKEN=$(./tools/get-user-token.sh <username> <password>)

# Use in requests
curl -X GET "http://localhost:4004/odata/v4/mcp/Health()" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json"
```

## Verification

### Check Grant Types

After deployment, verify grant types are enabled:

```bash
# Get XSUAA service instance details
cf service cloud-llm-hub-auth

# Or check in BTP Cockpit:
# Security → Trust Configuration → Application → OAuth2 Configuration
```

### Test User Token

```bash
# Test with user token
TOKEN=$(./tools/get-user-token.sh <username> <password>)
curl -H "Authorization: Bearer $TOKEN" http://localhost:4004/odata/v4/mcp/Health()
```

## Troubleshooting

### Issue: "unsupported_grant_type"

**Error:** `{"error":"unsupported_grant_type","error_description":"..."}`

**Solution:**
1. Verify `xs-security.json` has `grant-types` configured
2. Redeploy MTA to update XSUAA service
3. Wait a few minutes for XSUAA to update configuration

### Issue: "invalid_grant" for password grant

**Error:** `{"error":"invalid_grant","error_description":"..."}`

**Possible causes:**
- Password grant not enabled in XSUAA
- User credentials incorrect
- User doesn't have required role collections assigned

**Solution:**
1. Check if password grant is in `grant-types` array
2. Verify user credentials
3. Assign role collections in BTP Cockpit:
   - Security → Role Collections
   - Find "MCP Connector Access" or "MCP Admin Access"
   - Add your user

### Issue: "invalid_client" for authorization_code

**Error:** `{"error":"invalid_client","error_description":"..."}`

**Possible causes:**
- Redirect URI mismatch
- Client ID incorrect

**Solution:**
1. Verify redirect URI matches one in `redirect-uris` array
2. Check client ID from `default-env.json`

## Grant Types Explained

- **`authorization_code`**: Browser-based OAuth flow (most secure, recommended for production)
- **`password`**: Username/password direct authentication (convenient for testing, less secure)
- **`client_credentials`**: Service-to-service authentication (default, always available)
- **`refresh_token`**: Token refresh (allows getting new tokens without re-authentication)

## Related Documentation

- [Hybrid Debugging Authentication](HYBRID_DEBUG_AUTH.md)
- [Hybrid Debugging Setup](HYBRID_DEBUG_SETUP.md)
- [XSUAA Documentation](https://help.sap.com/docs/btp/sap-business-technology-platform/configure-oauth2-scopes)

