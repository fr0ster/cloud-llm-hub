# Principal propagation to on-premise ABAP

How a hub user, logged on through the subaccount's IdP (e.g. SAP Cloud Identity
Services with users provisioned into ABAP by Identity Provisioning), reaches an
on-premise ABAP system as **their own ABAP user**, without a password, through
an SAP BTP destination with principal propagation. Status: design — the hub does
not support it yet (see [Changes to the existing code](#changes-to-the-existing-code)).

## Which transport

| Transport | Through Cloud Connector from a Node.js app on CF | Verdict |
|-----------|--------------------------------------------------|---------|
| **HTTPS (ADT on ICM)** | Supported: Connectivity proxy + SAP Cloud SDK, PrincipalPropagation destination | **Use this** |
| RFC (`RfcTransport`, `SADT_REST_RFC_ENDPOINT`) | Not supported: RFC via the Connectivity service is JCo only, on the SAP Java Buildpack (Tomcat/TomEE) | Out of scope on CF |
| TCP (SOCKS5 proxy) | Generic TCP only; "cannot be used as a general-purpose proxy"; the NW RFC SDK has no Cloud Connector support | No |

Sources (SAP-docs/btp-connectivity):
- *Invoking ABAP Function Modules via RFC* — "The supported runtime environment is
  SAP Java Buildpack as of version 1.8.0. You must use the Tomcat or TomEE runtime
  offered by the build pack to make JCo work correctly. You cannot bring a
  container of your own."
- *Using the TCP Protocol for Cloud Applications* — "You cannot use the provided
  SOCKS5 proxy as general-purpose proxy."
- *Set Up Trust* — "For HTTPS and WebSocket RFC, you must import a system
  certificate (X.509 certificate) into your Cloud Connector."

`RfcTransport` stays useful where the hub has direct network access to the
system (local / VPC runs), not through Cloud Connector from CF.

## Architecture

```
LLM Client / UI
  │  OAuth login → user JWT
  │  Bearer token
  ▼
cloud-llm-hub — SAP BTP Cloud Foundry
  │  CAP + XSUAA authentication
  ▼
Agent / MCP tool execution
  │  UserContext: JWT + tenant + destination
  ▼
mcp-abap-adt library
  │  ADT operations, CSRF, cookies, sessions
  ▼
CloudSdkAbapConnection
  │  SAP Cloud SDK HTTP client
  │  destination + user JWT
  ▼
Destination Service + Connectivity Service
  ▼
SAP Cloud Connector
  │  HTTPS mapping + principal propagation
  │  X.509 user certificate
  ▼
On-premise ABAP
     ICM → /sap/bc/adt/*
     certificate mapping → ABAP user
```

## Sequence of one ADT request

1. The user authenticates to cloud-llm-hub through XSUAA.
2. CAP validates the JWT and builds the user context.
3. The agent calls a tool from mcp-abap-adt.
4. `CloudSdkAbapConnection` runs `executeHttpRequest()` with the `destinationName`
   and this user's JWT.
5. The SAP Cloud SDK fetches the destination and the Connectivity proxy settings.
6. The Connectivity service and Cloud Connector perform the principal propagation
   (the SDK sends `SAP-Connectivity-Authentication: Bearer <user JWT>`; Cloud
   Connector issues a short-lived X.509 certificate for the user).
7. ABAP maps the X.509 identity to a user and checks that user's authorizations.
8. The HTTP response returns along the same route.

## Changes to the existing code

| Component | What to do |
|-----------|------------|
| `srv/lib/btp-destinations.ts` | Allow `PrincipalPropagation` in the filter (`isSapAbapDestination` passes only `BasicAuthentication` today) |
| `srv/connections/destinationResolver.ts` | Handle `PrincipalPropagation` (the JWT path exists only for `OAuth2SAMLBearerAssertion`) |
| `srv/connections/CloudSdkAbapConnection.ts` | Pass the user's JWT in the destination options |
| Agent execution context | Keep the user JWT for the whole run |
| `srv/mcp-proxy.ts` | Pass the JWT in probe requests |
| ABAP transport | Keep CSRF, cookies, ETag and session handling |

Target call:

```ts
const response = await executeHttpRequest(
  {
    destinationName: 'ABAP_ADT',
    jwt: userJwt,
  },
  {
    method: 'GET',
    url: '/sap/bc/adt/discovery',
    headers: {
      Accept: 'application/atomsvc+xml',
    },
  },
);
```

### Architecture decision: Basic and PrincipalPropagation side by side

Principal propagation is not the only way to connect. The hub supports both
`BasicAuthentication` and `PrincipalPropagation` through the same
`CloudSdkAbapConnection`. Existing destinations keep working, and systems with
SSO are added one by one.

### Where the user JWT comes from (checked in the code)

The concern: if the agent runs asynchronously or under a technical
`client_credentials` token, principal propagation cannot determine the end ABAP
user.

- **Chat UI and OpenAI / Anthropic endpoints** — the approuter forwards the user's
  XSUAA token (`forwardAuthToken: true`); the per-request ABAP connection is built
  inside the HTTP request from `req.headers.authorization`
  (`srv/lib/request-connection.ts`, `srv/agent-mcp.ts`) and kept in an
  `AsyncLocalStorage` scope (`srv/agent-manager.ts`) for the agent run. The user
  JWT is available — provided nothing outlives the request.
- **Service clients (`sb-…` Basic auth)** — `srv/lib/basic-to-bearer.ts` exchanges
  them for an XSUAA **client_credentials** token. It carries no user, so it
  **cannot be propagated**. These callers need a Basic destination or the
  `x-sap-login` / `x-sap-password` override.
- **Today an OnPremise destination always requires `x-sap-login` /
  `x-sap-password`** (`requiresUserCredentials` in `request-connection.ts` and
  `agent-mcp.ts`). For a `PrincipalPropagation` destination that check must not
  apply, and the Basic override must not replace the JWT.
- Long agent runs: the JWT must stay valid for the whole run (XSUAA access token
  lifetime); anything detached from the request (background jobs, warm-up,
  tool vectorization) has no user and must not call a PrincipalPropagation
  destination on a user's behalf.

## What SAP Basis provides

```properties
# BTP destination
Name=ABAP_ADT
Type=HTTP
ProxyType=OnPremise
Authentication=PrincipalPropagation
URL=https://<virtual-host>:<virtual-port>
sap-client=100
```

> Note: for `ProxyType=OnPremise` SAP's examples use `http://<virtual-host>:<virtual-port>`:
> the cloud leg runs in the Cloud Connector tunnel, and Cloud Connector → ABAP is
> HTTPS by the system mapping's protocol. Use whichever scheme matches the
> virtual host's mapping.

Cloud Connector must allow `/sap/bc/adt/*`, and ABAP must trust the principal
propagation certificates and map them to the right users. Detailed checklist:

### BTP subaccount
- [ ] Trust to the IAS tenant (OpenID Connect) for business users — active.
- [ ] The destination above; `CloudConnectorLocationId` if the connector has one.

### Cloud Connector (2.13 or newer)
- [ ] **HTTPS system mapping** to the ABAP ICM: Back-end Type *ABAP System*,
      Protocol *HTTPS*, internal host + ICM HTTPS port, virtual host + port.
      An RFC-only mapping is not enough.
- [ ] Principal Type of the mapping: **X.509 Certificate (General Usage)**.
- [ ] Resources: `/sap/bc/adt/` (path and all sub-paths); optionally `/sap/bc/ping`.
- [ ] *Cloud to On-Premise → Principal Propagation*: **Synchronize** trust, mark the
      subaccount IdP / XSUAA entries *Trusted*; consider *Automatic Trust
      Synchronization* (key rotation).
- [ ] **System certificate** (mTLS client certificate of the connector) imported.
- [ ] **CA certificate** for signing short-lived certificates imported.
- [ ] **Subject pattern**, e.g. `CN=${email}` or `CN=${user_name}` — the attribute
      Identity Provisioning uses for the ABAP user. Generate a **sample certificate**
      for the ABAP mapping.

### ABAP system
- [ ] `STRUST`: SSL Server Standard trusts the issuer of the CC system certificate.
- [ ] `RZ10`: `icm/trusted_reverse_proxy_<n> = SUBJECT="<CC system cert subject>", ISSUER="<its issuer>"`
      (older releases: `icm/HTTPS/trust_client_with_issuer` / `_subject`).
- [ ] `icm/server_port_<n>` for HTTPS has `VCLIENT=1` (request certificate) or `2`.
- [ ] Restart ICM (`SMICM` → Exit Hard → Global) and verify the parameters.
- [ ] User mapping: `CERTRULE` with the sample certificate and
      `login/certificate_mapping_rulebased=1`, or explicit `EXTID_DN` entries.
- [ ] The provisioned ABAP users have ADT authorizations (`S_ADT_RES`, `S_DEVELOP`, …).

## Not needed for this flow

`@mcp-abap-adt/auth-providers` 6 (`OidcTokenExchangeProvider`, SAML2 bearer
exchange) is only needed for an exchange-based flow (e.g.
`OAuth2SAMLBearerAssertion` to an ABAP OAuth server), not for Cloud Connector
principal propagation.
