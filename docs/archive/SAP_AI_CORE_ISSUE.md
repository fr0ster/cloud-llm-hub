# SAP AI Core Integration Issue

## Problem Summary

The application `cloud-llm-hub-srv` is deployed on SAP BTP and has successfully bound to the SAP AI Core service (`aicore` service plan `extended`). However, when attempting to call the SAP AI Core API, we encounter two issues:

1. **403 Forbidden** when trying to obtain an OAuth2 token
2. **404 Not Found** when calling the SAP AI Core API endpoint

## Current Configuration

### Service Binding
- **Service Name**: `cloud-llm-hub-ai-core`
- **Service Type**: `aicore`
- **Service Plan**: `extended`
- **Binding Status**: ✅ Successfully bound

### Service Credentials Available
The service binding provides the following credentials:
- `clientid`: ✅ Present
- `clientsecret`: ✅ Present
- `serviceurls.AI_API_URL`: `https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com`
- `url`: `<tenant-specific>.authentication.<region>.hana.ondemand.com`

## Error Details

### Error 1: OAuth2 Token Request (403 Forbidden)

**Request Details:**
- **URL**: `<tenant-specific>.authentication.<region>.hana.ondemand.com/oauth/token`
- **Method**: POST
- **Headers**:
  ```
  Content-Type: application/x-www-form-urlencoded
  ```
- **Request Body** (URL-encoded):
  ```
  grant_type=client_credentials
  client_id=<clientid_from_service_binding>
  client_secret=<clientsecret_from_service_binding>
  ```

**Actual Error from Application Logs:**
```json
{
  "level": "warn",
  "logger": "agent-manager",
  "msg": "Failed to get OAuth2 token from service binding",
  "error": "Request failed with status code 403"
}
```

**Error Response:**
- **Status Code**: `403 Forbidden`
- **Response Body**: Not logged (axios error)

**Possible Causes:**
1. The service binding credentials (`clientid`/`clientsecret`) may not have the required OAuth2 scopes
2. The OAuth2 endpoint URL may be incorrect
3. The credentials may need additional configuration in SAP AI Core Launchpad
4. The OAuth2 endpoint may require different grant type or additional parameters

### Error 2: SAP AI Core API Request (404 Not Found)

**Request Details:**
- **Base URL**: `https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com`
- **Endpoint**: `/v1/chat/completions`
- **Full URL**: `https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com/v1/chat/completions`
- **Method**: POST
- **Headers**: 
  ```
  Content-Type: application/json
  Authorization: Basic <base64(clientid:clientsecret)>
  ```
  Note: OAuth2 token request failed (403), so Basic auth is used as fallback

**Request Body:**
```json
{
  "model": "gpt-4o-mini",
  "messages": [
    {
      "role": "user",
      "content": "<user_message>"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 2000
}
```

**Actual Error from Application Logs:**
```json
{
  "level": "error",
  "logger": "agent-manager",
  "msg": "SAP Core AI API error",
  "destination": "cloud-llm-hub-ai-core",
  "error": "Request failed with status code 404",
  "response": ""
}
```

**Error Response:**
- **Status Code**: `404 Not Found`
- **Response Body**: Empty (not logged)

**Possible Causes:**
1. The model `gpt-4o-mini` may not be deployed in SAP AI Core Launchpad
2. The API endpoint path may be incorrect (e.g., may require deployment ID: `/api/v1/inference/deployments/{deployment_id}/v1/chat/completions`)
3. The base URL may be incorrect for this region/tenant
4. The service binding may need additional configuration in SAP AI Core Launchpad
5. The endpoint may require different authentication (OAuth2 token instead of Basic auth)

## Questions for SAP AI Core Admin

1. **OAuth2 Authentication:**
   - What is the correct OAuth2 endpoint URL for obtaining an access token?
   - Do the service binding credentials (`clientid`/`clientsecret`) have the required scopes?
   - Should we use a different authentication method (e.g., mTLS, API key)?

2. **API Endpoint:**
   - What is the correct API endpoint for chat completions?
   - Is it `/v1/chat/completions` or does it require a deployment ID (e.g., `/api/v1/inference/deployments/{deployment_id}/v1/chat/completions`)?
   - What is the correct base URL for the API in region `eu-central-1`?

3. **Model Deployment:**
   - Is the model `gpt-4o-mini` deployed in SAP AI Core Launchpad?
   - If not, what models are available?
   - What is the deployment ID for the model we should use?

4. **Service Binding Configuration:**
   - Are there any additional configurations required in SAP AI Core Launchpad for the service binding?
   - Should we configure any specific scopes or permissions?

## Application Logs

The application logs show:
- ✅ Service binding is correctly identified
- ✅ Credentials are present and accessible
- ❌ OAuth2 token request fails with 403
- ❌ API request fails with 404

### Detailed Error Sequence

1. **Service Binding Detection** (✅ Success):
   ```json
   {
     "level": "info",
     "msg": "Using SAP Core AI provider via service binding",
     "serviceName": "cloud-llm-hub-ai-core",
     "serviceUrl": "https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com",
     "hasCredentials": true
   }
   ```

2. **OAuth2 Token Request** (❌ Fails):
   ```json
   {
     "level": "warn",
     "msg": "Failed to get OAuth2 token from service binding",
     "error": "Request failed with status code 403"
   }
   ```

3. **API Request with Basic Auth** (❌ Fails):
   ```json
   {
     "level": "error",
     "msg": "SAP Core AI API error",
     "destination": "cloud-llm-hub-ai-core",
     "error": "Request failed with status code 404",
     "response": ""
   }
   ```

4. **Final Error** (❌ Propagated to client):
   ```json
   {
     "level": "error",
     "msg": "Chat handler error",
     "error": "SAP Core AI API error: Request failed with status code 404"
   }
   ```

## Next Steps

1. Verify model deployment in SAP AI Core Launchpad
2. Confirm correct API endpoint structure
3. Verify OAuth2 endpoint and scopes
4. Test API access with service binding credentials

## Contact Information

- **Application**: `cloud-llm-hub-srv`
- **Space**: `dev`
- **Service Instance**: `cloud-llm-hub-ai-core`

