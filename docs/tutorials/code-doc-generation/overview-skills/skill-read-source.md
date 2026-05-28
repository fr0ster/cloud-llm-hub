---
name: abap-read-source
description: Load full ABAP program source via MCP — main program, all includes, active enhancements and BAdI implementations — before any analysis
---

# abap-read-source

## Steps (each tool call exactly ONCE)

1. `ReadProgram(<name>)` — main source.
2. `GetIncludesList(<name>)` — all include names.
3. `GetInclude(<include_name>)` — for every include from step 2.
4. `GetProgFullCode(<name>, <type>)` - reading a full report code.

## Output

List every loaded artifact:
- main program
- includes (name + type)
- enhancements / BAdIs found (name + implementation class/FM)
- anything inaccessible — mark as missing, never invent

## If MCP returns an error

If any step fails with an authorization error (401, "Nicht autorisiert", or similar):
- Stop immediately.
- Report the error to the user: which tool failed, what the error was, what access is needed.
- Do NOT proceed to analysis. Do NOT produce a document with "unknown" or "undetermined" sections.
