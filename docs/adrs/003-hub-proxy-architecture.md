# ADR 003: Cloud LLM Hub as MCP Proxy

## Status

Proposed

## Context

We need a single cloud-facing entry point that governs access to multiple Model Context Protocol (MCP) servers. Each request must be authenticated, authorized, and routed with consistent observability. The first integration target is the `mcp-abap-adt` server, but the hub must allow future MCP backends or replacements without major refactoring.

## Decision

- Host the hub as a CAP Node.js application (CAP 9) using TypeScript for service logic.
- Expose a CAP service that validates bearer tokens from request headers. Requests without valid tokens are rejected early.
- After validation, use HTTP/SSE or stream-http to proxy calls to the configured MCP backend.
- Consume the MCP implementation(s) through git submodules (starting with `services/mcp-abap-adt`).
- Provide a registry layer that keeps track of active MCP tools, health states, and capabilities exposed through the hub.

## Consequences

- The hub remains the single enforcement point for auth and auditing.
- MCPs can be swapped or extended by updating the submodule path or registry configuration.
- All client traffic passes through the CAP service, allowing consistent tracing, rate limiting, and token checks.
- Additional work is required to build robust proxy logic (timeouts, retries, streaming support) and maintain compatibility with MCP protocol changes.
