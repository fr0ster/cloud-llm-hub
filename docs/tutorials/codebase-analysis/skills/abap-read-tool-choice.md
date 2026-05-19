---
name: abap-read-tool-choice
description: Pick the right ABAP read tool — ReadProgram vs ReadClass vs ReadFunctionGroup vs GetIncludesList vs GetInclude
trigger: about to read ABAP source via the cloud-llm-hub MCP tool layer
---

# abap-read-tool-choice

Decision-only skill. Tells you which ABAP read tool to call given what you know about the object.

## Available read tools

| Tool | Returns | Use when |
|------|---------|----------|
| `ReadProgram(name)` | Main program source + metadata (package, responsible, description) | Object type = PROG |
| `ReadClass(name)` | Class source + metadata | Object type = CLAS |
| `GetClass(name, version?)` | Class source (active or inactive) | You need the inactive version, or `ReadClass` is unavailable |
| `ReadInterface(name)` | Interface source + metadata | Object type = INTF |
| `ReadFunctionGroup(name)` | FUGR source — typically already includes the listing of member includes/function modules | Object type = FUGR. After this you usually do NOT need GetIncludesList for the FUGR itself. |
| `GetIncludesList(program)` | List of include names attached to a program, **recursive** | After `ReadProgram`, before reading individual includes |
| `GetInclude(include_name)` | Source of a single include | One name returned by `GetIncludesList` |

## Decision flow

```
You know the seed name. You need its full source.

(1) Do you know the type?
    No  -> call SearchObject first, branch on result.
    Yes -> continue.

(2) Branch by type:

    PROG  -> ReadProgram(seed)
             -> GetIncludesList(seed)   # recursive — covers nested includes
             -> for each include name in the list: GetInclude(name)

    CLAS  -> ReadClass(seed)
             -> done (no separate "includes" — class structure is self-contained in the returned source)

    INTF  -> ReadInterface(seed)
             -> done.

    FUGR  -> ReadFunctionGroup(seed)
             -> usually done. If the response indicates extra include names you need,
                call GetInclude on each.
```

## Common mistakes

- **Calling `ReadProgram` on an include name.** Includes are not top-level objects; `ReadProgram` returns `source_code: null`. Use `GetInclude(include_name)` instead.
- **Trying to recurse `GetIncludesList` manually.** It is already recursive — one call returns every nested include name for the program. Just iterate the result.
- **Skipping `GetIncludesList` because the main program "looks short".** Many ABAP reports are a shell of `INCLUDE ZFOO_TOP. INCLUDE ZFOO_F01. PERFORM main.` — the real logic lives in the F01 include. A verdict based on the main program alone is unsound.
- **Calling `SearchSource` to "check if a program exists".** `SearchSource` is package-scoped text search. Existence checks use `SearchObject`.
- **Mentioning `SearchObject` and `SearchSource` in the same prompt.** The model conflates them and picks the wrong one. Keep them in separate stages / prompts.

## When you cannot read

If `GetInclude(X)` returns null, name `X` explicitly in the verdict. Do not silently downgrade to `unclear` — say which include blocked the read so a later stage knows what to investigate.

## Related

- `method-discovery` — the Stage-2 skill that drives the read.
- `lessons/abap-include-chain-needs-deeper-read.md` — failure mode when the include step is skipped.
- `lessons/searchobject-vs-searchsource.md` — failure mode when the existence-check tool is confused with the text-search tool.
