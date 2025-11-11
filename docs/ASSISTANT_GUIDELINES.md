# Assistant Interaction Guidelines

## Core Rules

### Language Requirements

- **All repository artifacts authored by the assistant** (source code, documentation, comments, commit messages, etc.) **must be written in English**.
- **Direct communication with the user** must follow the language used by the user in the current conversation.
- **Code comments and documentation** must be in English, regardless of conversation language.

### Key Principles

1. **Keep repository artifacts in English** while mirroring the user's language in conversation.
2. **Capture essential project context** (name, purpose, modules, commands, build hooks, runtime notes, tests) so new sessions recover quickly.
3. **Reference build automation** (`mta.yaml`, `copy-mcp-submodule.js`) whenever deployment packaging is discussed.
4. **Maintain consistency** across all code, documentation, and repository artifacts.

## Project Snapshot

- **Name:** Cloud LLM Hub – SAP CAP service that exposes streaming MCP endpoints (SSE + Streamable HTTP) backed by the `mcp-abap-adt` MCP server.
- **Key Modules:** 
  - `srv/` contains the CAP handlers
  - `app/router/` hosts the approuter
  - `submodules/mcp-abap-adt/` is the TypeScript MCP backend compiled to `dist/`
  - `submodules/llm-agent/` is the LLM agent orchestrator compiled to `dist/`
- **Primary Commands:**
	- `npm install` followed by `cds watch --profile development` for local work.
	- `npx cds build --production` to generate `gen/` artifacts.
	- `npx mbt build --mtar cloud-llm-hub.mtar` then `cf deploy ... --abort-on-error --delete-services` for SAP BTP deployment.
- **Build Hooks:** `mta.yaml` runs `npm ci` inside submodules, builds them, installs root dependencies, executes `cds build`, and copies the compiled submodule payloads into `gen/srv/submodules/` via `tools/copy-mcp-submodule.js` and `tools/copy-llm-agent-submodule.js`.
- **Runtime Notes:** 
  - Production dependencies include `dotenv`
  - The srv module imports from `@fr0ster/mcp-abap-adt/dist/...` to load the packaged MCP code at runtime
  - The srv module imports from `@cloud-llm-hub/llm-agent/dist/...` to load the packaged LLM agent code at runtime
- **Testing:** Smoke scripts live in `test/smoke/`; health endpoints are `/mcp/Health` and `/agent/Health`.

Use this snapshot to rehydrate context quickly when a new chat session starts.

## Code and Documentation Standards

### Code Artifacts

- **Source code** (`.ts`, `.js`, `.cds` files): English only
- **Comments**: English only, explain "why" not "what"
- **Variable/function/class names**: English only, follow naming conventions from `docs/contributors/CODE_STYLE.md`
- **Error messages**: English only
- **Log messages**: English only

### Documentation

- **README files**: English only
- **API documentation**: English only
- **Code examples**: English only
- **Commit messages**: English only, follow conventional commits format
- **CHANGELOG entries**: English only

### User Communication

- **Conversation responses**: Match user's language (Ukrainian, English, etc.)
- **Explanations**: Match user's language
- **Questions**: Match user's language
- **Error explanations**: Match user's language

## Git Submodules

This project uses Git submodules:
- `submodules/mcp-abap-adt/` - MCP server for ABAP ADT
- `submodules/llm-agent/` - LLM agent orchestrator

**Important:**
- Submodules have their own `ASSISTANT_GUIDELINES.md` files
- When working in submodules, follow their specific guidelines
- Changes to submodules should be committed in the submodule repository first
- Main project references submodules via git submodule pointers

## Configuration Files

### Sensitive Data

- **Never commit** files with real credentials or sensitive data
- Use `.template` files for version control (e.g., `mta-deploy.yaml.template`)
- Actual configuration files (e.g., `mta-deploy.yaml`) should be in `.gitignore`
- Document required environment variables and configuration in templates

### Environment Variables

- Use environment variables for deployment-specific configuration
- Document all required variables in `mta.yaml` or configuration templates
- Provide default values where appropriate
- Use MTA parameters (`~{PARAM_NAME}`) for externalization

## Build and Deployment

### MTA Deployment

- Use `mta-deploy.yaml` for deployment parameters (not committed to Git)
- Use `mta-deploy.yaml.template` as a template (committed to Git)
- Run `npm run deploy:prepare` to prepare deployment
- Run `npm run deploy:build` to build MTA archive
- Run `npm run deploy:deploy` to deploy to BTP

### Build Process

1. Install dependencies: `npm install`
2. Build submodules (handled by `mta.yaml` hooks)
3. Build CAP service: `npx cds build --production`
4. Copy submodule artifacts to `gen/srv/submodules/`
5. Package MTA archive: `npx mbt build`

## Testing

- **Test files**: English only (names, descriptions, comments)
- **Test data**: Can use realistic examples but keep names in English
- **Test documentation**: English only
- Follow testing guidelines in `docs/contributors/TESTING.md`

## Error Handling

- **Error messages**: English only
- **Log messages**: English only
- **User-facing errors**: Can be translated based on user's language preference
- **Technical errors**: Always in English for debugging

## Code Review Checklist

When reviewing code or documentation:

- [ ] All code comments are in English
- [ ] All variable/function/class names are in English
- [ ] All documentation is in English
- [ ] All commit messages are in English
- [ ] Error messages are in English
- [ ] Log messages are in English
- [ ] Code follows style guide (`docs/contributors/CODE_STYLE.md`)
- [ ] No sensitive data in committed files
- [ ] Configuration templates are up to date

## Additional Resources

- **Code Style**: `docs/contributors/CODE_STYLE.md`
- **Architecture**: `docs/contributors/ARCHITECTURE.md`
- **Testing**: `docs/contributors/TESTING.md`
- **Contributing**: `CONTRIBUTING.md`
