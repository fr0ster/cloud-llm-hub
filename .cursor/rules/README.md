# Cursor Rules

This directory contains project-specific rules for Cursor IDE.

## Structure

Rules are organized into separate `.mdc` files:
- `language-requirements.mdc` - Language and communication rules
- `project-context.mdc` - Project overview and key information
- `code-standards.mdc` - Coding standards and style guide
- `git-submodules.mdc` - Git submodules guidelines
- `configuration.mdc` - Configuration and deployment rules
- `error-handling.mdc` - Error handling guidelines
- `testing.mdc` - Testing guidelines

## How to Enable Rules in Cursor

1. **Open Cursor Settings:**
   - Press `Ctrl+,` (or `Cmd+,` on Mac) to open Settings
   - Or go to `File` → `Preferences` → `Settings`

2. **Enable Rules for AI:**
   - Search for "Rules for AI" or "Cursor Rules"
   - Make sure the option is enabled

3. **Reload Cursor:**
   - Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
   - Type "Reload Window" and select it
   - Or simply restart Cursor

4. **Verify Rules are Loaded:**
   - Open any file in the project
   - Rules should be automatically applied when using Cursor AI features
   - You can check if rules are loaded in Cursor's settings under "Rules for AI"

## Submodules

Each submodule has its own `.cursor/rules/` directory:
- `submodules/llm-agent/.cursor/rules/`
- `submodules/mcp-abap-adt/.cursor/rules/`

When working in a submodule, Cursor will use that submodule's rules.

## Legacy Support

The old `.cursorrules` file in the root directory is kept for backward compatibility, but the new `.cursor/rules/*.mdc` format is recommended.

