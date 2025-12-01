# Assistant Interaction Guidelines

- All repository artifacts authored by the assistant (source code, documentation, comments, commit messages, etc.) must be written in English.
- Direct communication with the user must follow the language used by the user in the current conversation.

### Key Principles

- Keep repository artifacts in English while mirroring the user’s language in conversation.
- Capture essential project context (name, purpose, modules, commands, build hooks, runtime notes, tests) so new sessions recover quickly.
- Reference `mta.yaml` build automation and the `copy-mcp-submodule.js` helper whenever deployment packaging is discussed.

## Project Snapshot

- **Name:** Cloud LLM Hub – SAP CAP service that exposes streaming MCP endpoints (SSE + Streamable HTTP) backed by the `mcp-abap-adt` MCP server.
- **Key Modules:** `srv/` contains the CAP handlers; `app/router/` hosts the approuter; `submodules/mcp-abap-adt/` is the TypeScript MCP backend compiled to `dist/`.
- **Primary Commands:**
  - `npm install` followed by `cds watch --profile development` for local work.
  - `npx cds build --production` to generate `gen/` artifacts.
  - `npx mbt build --mtar cloud-llm-hub.mtar` then `cf deploy ... --abort-on-error --delete-services` for SAP BTP deployment.
- **Build Hooks:** `mta.yaml` runs `npm ci` inside the submodule, builds it, installs root dependencies, executes `cds build`, and copies the compiled submodule payload into `gen/srv/submodules/mcp-abap-adt` via `tools/copy-mcp-submodule.js`.
- **Runtime Notes:** Production dependencies include `dotenv`; the srv module imports from `@fr0ster/mcp-abap-adt/dist/...` to load the packaged code at runtime.
- **Testing:** Smoke scripts live in `test/smoke/`; health endpoint is `/mcp/Health`.

Use this snapshot to rehydrate context quickly when a new chat session starts.
