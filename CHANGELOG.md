# Changelog

All notable changes to this project will be documented in this file. The format follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles.

## [0.1.0] - 2025-10-28
### Added
- Initial SAP CAP project scaffold with TypeScript support.
- Baseline MCP proxy service (`srv/mcp-proxy.cds` / `srv/mcp-proxy.ts`) protected via XSUAA scope `proxyAccess`.
- Cloud Foundry configuration artifacts (`xs-security.json`, approuter skeleton).
- Architecture decision records covering hub proxy design, CF auth/destinations, and TypeScript stack.
- Roadmap documentation with progress tracking.
