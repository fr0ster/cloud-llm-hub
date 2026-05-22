# Claude Code Sub-Agent

How to wire Cloud LLM Hub as a **named sub-agent** in
[Claude Code](https://claude.com/claude-code) so that the main Claude session can
delegate SAP queries to it with one call instead of crafting curl/SSE-parsing logic
each time.

> **Scope.** This page is about the *Claude Code Agent feature* — a markdown file under
> `~/.claude/agents/` that defines a specialized sub-agent. It is **not** about
> registering Cloud LLM Hub as an MCP server (that is a different integration, see
> [`MCP_CONNECTION.md`](MCP_CONNECTION.md)).
>
> Cloud LLM Hub is an **LLM agent with built-in MCP for ABAP** — it already knows which
> MCP tool to invoke for a given task. You describe what you need (read a program,
> describe a table, search the namespace); the SmartAgent picks the tool. You don't
> register MCP tools twice in your client; you delegate to the agent.
>
> | | MCP server registration | Sub-agent (this page) |
> |---|---|---|
> | What the main session sees | Raw MCP tools (ReadProgram, GetTable, …) | One delegate it invokes with a natural-language prompt |
> | Tool selection | The main session must pick the tool per call | The SmartAgent picks the tool from the task description |
> | Goes through SmartAgent + RAG | No | Yes |
> | Best for | Mechanical lookups by callers that know the tool names | Tasks described in business terms, where you don't want to think about tool selection |

## What you get

After the setup below, the main Claude Code session can do:

```js
Agent({
  description: "Inspect ZDEMO_REPORT",
  subagent_type: "cloud-llm-hub",
  prompt: "Describe the report ZDEMO_REPORT — purpose, includes, selection screen, what it touches. Destination: S4HANA_DEV."
})
```

…and the sub-agent does the full round-trip to your Cloud LLM Hub. The SmartAgent
inside the hub decides which MCP tools to call (`ReadProgram`, `GetIncludesList`,
`GetInclude`, …), runs them, composes the answer, streams it back. The sub-agent
parses the SSE stream and returns the assistant's text. No curl, no JSON escaping, no
parsing in the parent context, no manual tool selection.

You can also name a tool explicitly when you want a mechanical lookup — the SmartAgent
will honour it. But you don't have to.

## Prerequisites

1. **Claude Code installed locally** ([claude.com/claude-code](https://claude.com/claude-code)).
2. **Cloud LLM Hub reachable from your workstation.** Two common setups:
   - *Local approuter* on `http://127.0.0.1:3001` (recommended for SAP destinations
     on a customer subaccount — start the local proxy first; see
     [`MCP_CONNECTION.md`](MCP_CONNECTION.md#proxy)).
   - *Direct BTP endpoint* (`https://cloud-llm-hub-srv.<region>.hana.ondemand.com`)
     with a valid JWT.
3. **A known destination name** for the SAP system you want to query (e.g.
   `S4HANA_DEV`, `S4HANA_CLOUD`, or whatever your BTP subaccount exposes).

> **The sub-agent does NOT start the proxy.** If you go through a local approuter,
> bring it up first and confirm it is pointing at the correct BTP subaccount before
> delegating. Mismatched routing fails silently or hits the wrong SAP system.

## How to define the agent

Create the file `~/.claude/agents/cloud-llm-hub.md`. Claude Code auto-discovers agent
definitions there on session start.

The file is plain markdown with YAML front-matter:

```markdown
---
name: cloud-llm-hub
description: <one-paragraph rule for when the main session should invoke this agent>
tools: Bash
model: haiku
---

<system prompt for the sub-agent — endpoint, request shape, parsing, hard rules>
```

Front-matter fields:

| Field | What it does |
|---|---|
| `name` | The id used in `Agent({subagent_type: "..."})`. Lowercase, kebab-case. |
| `description` | The single most important field — Claude Code reads this to decide whether the current task matches the agent. Be specific and end with conditions ("must specify destination", "do not invoke for general questions"). |
| `tools` | Comma-separated list of tools the sub-agent is allowed to use. For a Cloud LLM Hub gateway, `Bash` is enough (the sub-agent only runs curl + python for SSE parsing). |
| `model` | Optional. `haiku` is a good default — sub-agent's job is mechanical forwarding, not reasoning. |

## Example file

Save the following as `~/.claude/agents/cloud-llm-hub.md`. Adjust the endpoint URL and
the list of common destinations to match your environment.

```markdown
---
name: cloud-llm-hub
description: Gateway to the user's local Cloud LLM Hub (127.0.0.1:3001). Cloud LLM Hub is an LLM agent with built-in MCP for ABAP — it already knows which MCP tool to use for a given task. Invoke whenever the parent task needs SAP system access: read ABAP/RAP source or metadata, describe DDIC objects (tables, CDS, function modules, classes), search the namespace, run dependent multi-tool sequences. Describe what you need; the SmartAgent picks the tools. One round-trip per invocation. The caller MUST specify the target SAP destination in the prompt — no default. PRECONDITION — the local approuter on :3001 routes to a BTP subaccount through a proxy that the user must have started first. The agent does NOT start the proxy. Confirm proxy state with the user before invoking.
tools: Bash
model: haiku
---

# cloud-llm-hub gateway

You are a focused, single-purpose gateway between the parent agent and the user's
local Cloud LLM Hub at `http://127.0.0.1:3001`. You translate the caller's prompt
into **one** `POST /v1/chat/completions` call, parse the SSE stream, and return
the assistant's text plus a small evidence summary.

The Cloud LLM Hub itself is an LLM agent with built-in MCP for ABAP. It picks the
right MCP tool (ReadProgram, GetTable, SearchSource, …) for the task in the prompt.
You do NOT need to name a tool — describing the goal is enough.

You are not a planner. You don't decompose. You don't loop.

## Endpoint

POST http://127.0.0.1:3001/v1/chat/completions
Content-Type: application/json
x-sap-destination: <DESTINATION>

`<DESTINATION>` is the BTP destination name the caller must give you. Common values:

- `S4HANA_DEV` — on-premise DEV via the local acme-sandbox proxy
- `S4HANA_CLOUD` — acme-prod subaccount destination

If the caller's prompt does not contain a destination name, do NOT guess. Reply
with `ERROR: missing x-sap-destination — caller must specify the destination` and stop.

## Precondition — proxy must be running on the right subsystem

127.0.0.1:3001 is the user's local approuter, fronting a proxy (typically
acme-sandbox). Before invoking, the parent agent must have confirmed:

1. The proxy is up — port 3001 is open.
2. The proxy is pointing at the BTP subaccount that hosts the named destination.

If a smoke curl returns connection refused / "destination not found", stop and
report: `ERROR: proxy unreachable or pointing at the wrong subsystem`.

## How to run

Use Bash for one curl call. Build the JSON body with `jq -n --arg` so the caller's
prompt is escaped safely:

    TMP=$(mktemp --suffix=.sse)
    curl -sN -X POST http://127.0.0.1:3001/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -H "x-sap-destination: <DESTINATION>" \
      -d "$(jq -nc --arg c "<PROMPT>" '{model:"x",stream:true,stream_options:{include_usage:true},messages:[{role:"user",content:$c}]}')" \
      --max-time 240 > "$TMP"

## Parsing

The response is Server-Sent Events. Extract the assistant content from each chunk:

    python3 -c "
    import json, pathlib
    sse = pathlib.Path('$TMP').read_text()
    out, usage = [], None
    for line in sse.splitlines():
        if not line.startswith('data: ') or line == 'data: [DONE]':
            continue
        try: j = json.loads(line[6:])
        except: continue
        for ch in j.get('choices', []):
            out.append(ch.get('delta', {}).get('content') or '')
        if j.get('usage'): usage = j['usage']
    print(''.join(out))
    if usage:
        print(f'---')
        print(f'usage: prompt={usage[\"prompt_tokens\"]} completion={usage[\"completion_tokens\"]} total={usage[\"total_tokens\"]}')
    "

Keep `[SmartAgent: Executing X...]` markers in the output verbatim — they are
evidence of real tool calls.

## Hard rules

- One curl per invocation. Do not split into multiple curls.
- Never invent the destination. Fail fast.
- Never modify the prompt body. Pass through verbatim.
- No retries. The parent decides whether to retry.
- Hallucination check: if no `[SmartAgent: Executing` line AND
  `prompt_tokens < 10000`, append a trailing warning:
  `WARN: response likely fabricated — no tool trace, low prompt-token count.`
```

## How to invoke

From the parent Claude Code session, call the standard `Agent` tool with
`subagent_type: "cloud-llm-hub"`:

```js
Agent({
  description: "Inspect SFTP report",
  subagent_type: "cloud-llm-hub",
  prompt: "Read program ZDEMO_FILE_TRANSFER together with every include it pulls in. Return the verbatim source for the main and each include, one ```abap fence per source unit. Destination: S4HANA_DEV."
})
```

The SmartAgent on the other side reads the request, plans the MCP tool sequence
(`ReadProgram` → `GetIncludesList` → `GetInclude` per name) and runs it. The parent
receives the assistant's text exactly as it streamed, including
`[SmartAgent: Executing …]` traces and the final `usage:` line.

## When to use this — and when not to

**Use the sub-agent when…**

- The parent task needs SAP code/metadata to proceed (analysis, review, doc
  generation).
- You want to describe the work in business terms ("document this report", "find all
  SFTP callers in Z001") and let the SmartAgent pick the MCP tools.
- You want to keep the parent context clean — SSE noise and parsing stay inside the
  sub-agent.

**Do NOT use it when…**

- You want to bypass the SmartAgent and call MCP tools directly from your own agent
  loop. Use an MCP-server registration for that — see
  [`MCP_CONNECTION.md`](MCP_CONNECTION.md).
- The proxy on `127.0.0.1:3001` is not running. The sub-agent does not start it.
- The destination is unknown. The sub-agent will refuse without one.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: missing x-sap-destination` | The caller's prompt did not include a destination name | Add `Destination: <NAME>` at the end of the prompt. |
| `ERROR: proxy unreachable` | Local approuter on `:3001` is not running, or it points at the wrong subaccount | Start the proxy (`npx mcp-abap-adt-proxy …` or your project's launcher). Verify it targets the subaccount that hosts the requested destination. |
| Response with `WARN: response likely fabricated` | The SmartAgent answered from memory rather than calling tools | Re-issue with a more explicit tool-call instruction (`Call ReadProgram exactly once. Return …`). Treat the current answer as unverified. |
| Sub-agent runs but returns empty | The prompt did not name a tool or a target object | Make the prompt explicit. The sub-agent is a gateway, not a generalist. |
| `subagent_type "cloud-llm-hub" not found` | Agent file missing, malformed front-matter, or Claude Code session was started before the file existed | Verify `~/.claude/agents/cloud-llm-hub.md` exists. Restart Claude Code. |

## Related

- [`OPENAI_AGENT.md`](OPENAI_AGENT.md) — the raw `/v1/chat/completions` endpoint the
  sub-agent talks to.
- [`MCP_CONNECTION.md`](MCP_CONNECTION.md) — the alternative integration path (MCP
  server registration in the client).
- [`GETTING_STARTED.md`](GETTING_STARTED.md) — broader onboarding for new users.
