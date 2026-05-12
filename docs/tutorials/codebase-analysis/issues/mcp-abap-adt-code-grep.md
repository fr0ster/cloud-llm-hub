# Issue draft: add source-text search to `mcp-abap-adt`

> Draft for upstream posting. Review before posting.

## Title

Add `SearchSource` tool for ABAP source-text search

## Problem

`mcp-abap-adt` supports object lookup and where-used traversal, but codebase analysis also needs source-text search for string-literal calls, command strings, configuration names, and generated/dynamic patterns.

Current workaround: run `<standard-abap-source-search-report>` manually or wrap it through `SUBMIT`.

## Proposed tool

`SearchSource(pattern, scope, options)` returning:

- object name and type
- include/source pointer and line
- one or two source lines containing the match
- effective scope
- `truncated: true|false`
- underlying search channel

## Acceptance criteria

- Search is callable over MCP.
- Scope supports namespace/package/object type filters.
- Truncation is machine-readable.
- Results include verifiable source pointers.
- Documentation explains how this complements `SearchObject` and `GetWhereUsed`.
