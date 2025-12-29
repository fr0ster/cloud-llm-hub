# Cloud LLM Hub

## Project Overview

**Cloud LLM Hub** is an enterprise-ready Model Context Protocol (MCP) proxy designed to connect SAP ABAP systems to AI assistants (like Cline, Claude Desktop) and automation tools (n8n, CI/CD). It is built using the **SAP Cloud Application Programming Model (CAP)** and runs on **SAP Business Technology Platform (BTP)**.

The solution provides a secure bridge for AI tools to interact with on-premise and cloud-based SAP systems, handling authentication, session management, and connectivity via the SAP Cloud Connector.

### Key Technologies
- **Framework:** SAP Cloud Application Programming Model (CAP) with Node.js
- **Language:** TypeScript
- **Infrastructure:** SAP BTP (Cloud Foundry), SAP Cloud SDK
- **Protocols:** MCP (Model Context Protocol) via SSE and Stream-HTTP
- **Authentication:** XSUAA (OAuth 2.0)
- **Linting/Formatting:** Biome

## Key Directories & Files

| Path | Description |
| :--- | :--- |
| `srv/` | **Backend Service:** Contains the MCP proxy implementation (`mcp-proxy.ts`, `mcp-manager.ts`) and connectivity logic. |
| `app/` | **Frontend/Router:** SAP BTP AppRouter configuration (`router/`) and local testing setup. |
| `db/` | **Database:** CAP data models (currently reserved for future persistence). |
| `docs/` | **Documentation:** Comprehensive guides for usage, architecture, deployment, and development. |
| `tools/` | **Utilities:** Helper scripts for configuration, versioning, and environment setup. |
| `test/` | **Tests:** Integration tests and test runners. |
| `package.json` | **Dependencies:** Lists project dependencies and scripts. |
| `mta.yaml` | **Deployment:** Multi-Target Application descriptor for BTP deployment. |
| `biome.json` | **Code Style:** Configuration for Biome linter and formatter. |

## Development Workflow

### Prerequisites
- Node.js (v18+)
- SAP CDS DK (`npm i -g @sap/cds-dk`)
- Cloud MTA Build Tool (`mbt`) (for deployment)

### Installation
```bash
npm install
```

### Running Locally
Start the CAP server in development mode. This uses mocked authentication (users: `alice`, `bob`).
```bash
cds watch --profile development
```
The server will be available at `http://localhost:4004`.

### Testing
Run the YAML-driven integration tests:
```bash
# Run integration tests
npm test

# Run unit tests
npm run test:unit
```
To run tests with custom configuration, copy `test/integration.yaml.template` to `test/integration.yaml` and adjust settings.

### Code Quality
The project uses **Biome** for linting and formatting.
```bash
# Check for linting issues
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code
npm run format
```

## Deployment (SAP BTP)

The project is deployed as a Multi-Target Application (MTA).

1.  **Build the MTA archive:**
    ```bash
    mbt build
    # or
    cds build --production
    ```
    *Note: The build process automatically handles submodules (`mcp-abap-adt`).*

2.  **Deploy to Cloud Foundry:**
    ```bash
    cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar
    ```

## Architecture Notes

*   **Authentication:**
    *   **Local:** Mocked using CAP's `mocked` auth strategy.
    *   **Production:** Uses `XSUAA` service. `srv/mcp-proxy.ts` handles user context.
*   **Connectivity:**
    *   Uses **SAP Cloud SDK** (`@sap-cloud-sdk/http-client`) for destination resolution and connectivity.
    *   Supports **On-Premise** connectivity via the Connectivity Service and Cloud Connector.
*   **MCP Implementation:**
    *   Exposes streaming endpoints (`GET /mcp/stream/sse`, `POST /mcp/stream/http`) in `srv/mcp-proxy.ts`.
    *   Manages MCP server instances dynamically in `srv/mcp-manager.ts`.

## Language Conventions

- **Artifacts:** All code, documentation, commit messages, and technical artifacts must be in **English**.
- **Communication:** Interaction with the AI agent is conducted in **Ukrainian**.
