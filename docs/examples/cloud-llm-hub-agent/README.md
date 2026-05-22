# cloud-llm-hub-agent

A ready-to-use [Claude Code](https://claude.com/claude-code) sub-agent that wraps the
user's local Cloud LLM Hub at `http://127.0.0.1:3001`. Copy the markdown file from this
folder into `~/.claude/agents/`, restart Claude Code, and the main session can delegate
SAP queries to it with one `Agent({subagent_type: "cloud-llm-hub", ...})` call.

For the full integration write-up — when to use it vs an MCP server registration,
prerequisites, prompt patterns, troubleshooting — see
[`docs/usage/CLAUDE_CODE_AGENT.md`](../../usage/CLAUDE_CODE_AGENT.md).

## Install

```bash
mkdir -p ~/.claude/agents
cp docs/examples/cloud-llm-hub-agent/cloud-llm-hub.md ~/.claude/agents/
# Restart Claude Code so /agents picks up the new file
```

The file name in `~/.claude/agents/` does not have to be `cloud-llm-hub.md` — Claude
Code reads the `name:` field from the front-matter. Keeping the same name avoids
surprises.

## Verify

After restart, in Claude Code:

1. Open `/agents` — `cloud-llm-hub` should appear in the list.
2. Make sure your local proxy on `127.0.0.1:3001` is running and pointing at the BTP
   subaccount that hosts your target destination. The sub-agent does NOT start the
   proxy.
3. Smoke test from the main session:

   ```js
   Agent({
     description: "Smoke",
     subagent_type: "cloud-llm-hub",
     prompt: "List up to 5 ABAP packages starting with Z*. Destination: <YOUR_DESTINATION>."
   })
   ```

   You should see `[SmartAgent: Executing SearchObject...]` followed by a small table.

## What's inside the agent file

- A description telling Claude Code when to delegate to it
- The endpoint + header contract (`x-sap-destination` is mandatory)
- A precondition note about the local proxy
- The curl + SSE-parse implementation the sub-agent runs
- Hard rules: one round-trip, no retries, hallucination check (no `[SmartAgent:
  Executing` line plus `prompt_tokens < 10000` → warn)
- Example prompt shapes (goal-style and tool-named) for the parent to reuse

## Customise per environment

Edit the file before copying if your setup differs from the defaults:

- **Endpoint URL.** Change all occurrences of `http://127.0.0.1:3001` if your local
  approuter runs elsewhere, or if you target a BTP-hosted Cloud LLM Hub directly.
- **Destination names.** The file lists `S4HANA_DEV` and `S4HANA_CLOUD` as common values.
  Replace with your team's destination names.
- **Model.** `model: haiku` is good for mechanical forwarding. Bump to `sonnet` if you
  want the sub-agent itself to do light reasoning on the response.

## See also

- [`docs/usage/CLAUDE_CODE_AGENT.md`](../../usage/CLAUDE_CODE_AGENT.md) — full
  integration guide.
- [`docs/usage/OPENAI_AGENT.md`](../../usage/OPENAI_AGENT.md) — the underlying
  `/v1/chat/completions` API the sub-agent talks to.
- [`docs/usage/MCP_CONNECTION.md`](../../usage/MCP_CONNECTION.md) — the alternative
  integration (register Cloud LLM Hub as an MCP server in the client).
