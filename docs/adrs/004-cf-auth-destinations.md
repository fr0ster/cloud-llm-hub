# ADR 004: Cloud Foundry Authentication and Destinations

## Status
Proposed

## Context

We deploy the hub on SAP BTP (Cloud Foundry runtime). The platform offers managed services for authentication (XSUAA) and destination management. We must decide how clients authenticate and how outbound calls to MCP servers obtain connection metadata securely.

## Decision

- Use an approuter + XSUAA instance for end-user or client authentication. The approuter issues JWT tokens that the hub validates.
- Define a single scope (`proxyAccess`) published via XSUAA; owning that scope is the only prerequisite for MCP proxy access.
- For automation scenarios where the approuter is bypassed, the hub accepts pre-shared bearer tokens in headers for MCP access.
- Store MCP endpoint details in Cloud Foundry Destinations. The hub reads destinations via destination service binding.
- Secrets and credentials stay in CF service bindings and are not embedded in source code.

## Consequences

- The hub relies on Cloud Foundry managed services for token issuance and destination resolution.
- Role collections in Cloud Foundry cockpit map to the single `proxyAccess` scope to grant users or service keys access to the MCP proxy.
- Client teams can benefit from standard OAuth flows via approuter, while automation can leverage header tokens.
- Local development requires mock configuration for destinations and tokens (e.g., `default-env.json`).
- If we move away from Cloud Foundry, equivalent identity and secret management services must be provided elsewhere.