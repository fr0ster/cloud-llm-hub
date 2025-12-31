# Assistant Interaction Guidelines

- All repository artifacts authored by the assistant (source code, documentation, comments, commit messages, etc.) must be written in English.
- Direct communication with the user must follow the language used by the user in the current conversation.

### Key Principles

- Keep repository artifacts in English while mirroring the user’s language in conversation.
- Capture essential project context (name, purpose, modules, commands, build hooks, runtime notes, tests) so new sessions recover quickly.
- Reference `mta.yaml` build automation for production-ready packaging.

## Project Snapshot

- **Name:** Cloud LLM Hub – SAP CAP service that exposes streaming MCP endpoints (SSE + Streamable HTTP).
- **Key Modules:** `srv/` contains the CAP handlers; `app/router/` hosts the approuter. Core logic is provided by `@mcp-abap-adt/core` and other scoped npm packages.
- **Primary Commands:**
  - `npm install` followed by `cds watch --profile development` for local work.
  - `npm run build:mta` to generate the optimized MTA archive.
  - `npm run deploy` to deploy to SAP BTP Cloud Foundry.
- **Build Hooks:** `mta.yaml` uses an optimized custom builder with `npm ci --omit=dev` and aggressive cleanup of unnecessary artifacts (source maps, documentation) to achieve a small deployment footprint (~16MB).
- **Runtime Notes:** Production dependencies are managed via npm.
- **Testing:** Integration tests are driven by YAML playbooks (`npm test`). Health endpoint is `/mcp/Health`.

Use this snapshot to rehydrate context quickly when a new chat session starts.
