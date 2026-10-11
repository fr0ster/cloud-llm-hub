# Principal propagation to on-premise ABAP

How a hub user, logged on through the subaccount's IdP (e.g. SAP Cloud Identity
Services with users provisioned into ABAP by Identity Provisioning), reaches an
on-premise ABAP system as **their own ABAP user**, without a password. Status:
analysis — the hub does not support it yet (see [Hub changes](#hub-changes)).

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

## Flow (HTTPS)

1. The user logs on to the approuter through the subaccount IdP (XSUAA trusts IAS).
2. The approuter forwards the user's XSUAA token to srv (`forwardAuthToken: true`).
3. srv calls the destination with the user's JWT; the Cloud SDK sends
   `SAP-Connectivity-Authentication: Bearer <user JWT>` to the Connectivity proxy.
4. Cloud Connector validates the token against the synchronized subaccount trust,
   issues a short-lived X.509 certificate for the user (subject from the subject
   pattern) and calls the ABAP ICM over mTLS with its system certificate.
5. ICM trusts the Cloud Connector as a reverse proxy; ABAP maps the certificate
   subject to the user (rule-based CERTRULE, or EXTID_DN).

## Checklist

### BTP subaccount
- [ ] Trust to the IAS tenant (OpenID Connect) for business users — active.
- [ ] Destination, `ProxyType=OnPremise`, `Authentication=PrincipalPropagation`,
      `URL=http://<virtual host>:<virtual port>` (the cloud leg runs in the
      tunnel; CC → ABAP is HTTPS by the mapping's protocol), `sap-client=<client>`,
      `CloudConnectorLocationId` if the connector has one.

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

## Hub changes

Code is in the hub, not in `@mcp-abap-adt/lib`: srv owns the connection
(`srv/connections/CloudSdkAbapConnection.ts`, Cloud SDK `executeHttpRequest`).

- `srv/lib/btp-destinations.ts` — accept `Authentication=PrincipalPropagation`
  (today only `BasicAuthentication` passes `isSapAbapDestination`).
- `srv/connections/CloudSdkAbapConnection.ts` — pass the user's JWT:
  `executeHttpRequest({ destinationName, jwt }, …)`; no Basic override for these
  destinations.
- `srv/connections/destinationResolver.ts` — treat `PrincipalPropagation` like the
  JWT path it already has for `OAuth2SAMLBearerAssertion`.
- Chat UI login gate — no SAP login/password for a destination that does not
  require credentials (`requiresCredentials` already exists in the metadata).
- API clients (OpenAI/Anthropic/MCP endpoints) — the caller's XSUAA token is the
  principal; a token without a user (client credentials) cannot be propagated.

`@mcp-abap-adt/auth-providers` 6 (`OidcTokenExchangeProvider`, SAML2 bearer
exchange) is only needed for an exchange-based flow (e.g.
`OAuth2SAMLBearerAssertion` to an ABAP OAuth server), not for Cloud Connector
principal propagation.
