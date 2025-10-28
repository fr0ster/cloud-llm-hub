# Getting Started

Welcome to your new project.

It contains these folders and files, following our recommended project layout:

File or Folder | Purpose
---------|----------
`app/` | content for UI frontends goes here
`db/` | your domain models and data go here
`srv/` | your service models and code go here
`package.json` | project metadata and configuration
`readme.md` | this getting started guide


## Next Steps

- Open a new terminal and run `cds watch`
- (in VS Code simply choose _**Terminal** > Run Task > cds watch_)
- Start adding content, for example, a [db/schema.cds](db/schema.cds).

## Authentication & Proxying

- XSUAA configuration resides in [`xs-security.json`](xs-security.json); it defines a single `proxyAccess` scope for MCP calls via the hub.
- `srv/mcp-proxy.cds` exposes `McpProxyService` guarded by `@requires: 'proxyAccess'`.
- The service currently responds with a stub health result and will proxy MCP requests once backends are wired.

## Project Documentation

- [Roadmap](docs/roadmap.md)
- [ADR Catalog](docs/adrs)
- [Changelog](CHANGELOG.md)


## Learn More

Learn more at https://cap.cloud.sap/docs/get-started/.
