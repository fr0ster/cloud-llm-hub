# Agent Orchestration — Future Improvements

## Overview

This document captures architectural ideas for evolving the cloud-llm-hub agent from a simple request/response chat into an intelligent task orchestrator that can handle complex multi-step requests, background processing, and result delivery to external systems.

## Problem

Current agent handles one prompt → one response synchronously. Real enterprise consumers need:

- Fire-and-forget with callback (Integration Suite, CodeJam workflows)
- Multi-action requests ("do A, then send result of A to B")
- Mix of foreground (immediate) and background (long-running) actions
- Delivery to various external systems (JIRA, ServiceNow, Slack, S/4HANA OData, etc.)

## Core Idea: MCP Tools for Orchestration

Instead of hardcoding delivery modes (sync/callback/store), expose orchestration primitives as MCP tools. LLM decides autonomously how to decompose and deliver based on the request context.

### Two Key MCP Tools

**`run_background`** — launches a background SmartAgent task:
- Input: `prompt` (what to do), `on_complete` (instructions for result delivery)
- Returns immediately with `taskId`
- Background agent has full pipeline: RAG, MCP ABAP tools, classification

**`result_sender`** — generic HTTP delivery tool:
- Input: `url`, `method`, `headers`, `body`
- Available to both foreground and background agents
- Works with any HTTP API: JIRA, ServiceNow, Slack, email gateway, S/4HANA OData

### Flow Example

```
Consumer request:
  "Analyze dump for user DEVELOPER, post analysis as JIRA comment on ABC-123,
   and reply to me with a summary"

Agent pre-analysis:
  1. Parse request → identify actions:
     a) Analyze dump (action, requires ABAP MCP tools)
     b) Post to JIRA (delivery, requires call_endpoint)
     c) Reply with summary (immediate response)
  2. Validate capabilities:
     a) Can analyze dump? → YES (have ReadDump MCP tool)
     b) Can post to JIRA? → YES (have result_sender + JIRA URL provided)
     c) Can reply? → YES (default)
  3. Check information sufficiency:
     a) Dump analysis — need user name → DEVELOPER ✓
     b) JIRA post — need issue ID → ABC-123 ✓, need JIRA URL → provided ✓
     c) Missing info? → NO, proceed
  4. Execution plan:
     - Foreground: reply with "Task launched, will post to JIRA when done"
     - Background: run_background({
         prompt: "Analyze dump for user DEVELOPER",
         on_complete: "Post result as comment to JIRA issue ABC-123
                       via POST https://jira.example.com/api/issue/ABC-123/comment"
       })

Background agent:
  1. Calls ABAP MCP tools → analyzes dump
  2. Gets result
  3. Calls result_sender({
       url: "https://jira.example.com/api/issue/ABC-123/comment",
       method: "POST",
       headers: {"Authorization": "Bearer ..."},
       body: "## Dump Analysis\n\nRoot cause: ..."
     })
  4. Updates task status: completed
```

## Pre-Analysis Phase (Critical)

Before executing anything, the agent MUST:

### 1. Action Decomposition
Parse the consumer request into discrete actions. A single request may contain multiple actions, similar to a simplified pipeline definition.

### 2. Capability Check
For each action, verify the agent has the necessary tools. If an action is impossible — return error immediately, do not partially execute.

### 3. Information Sufficiency
For each action, check if enough parameters are provided:
- Dump analysis needs: user name or dump ID
- JIRA comment needs: issue ID, JIRA instance URL
- Email needs: recipient address
- Missing info → return error listing what is needed

### 4. Execution Planning
Decide per-action:
- **Foreground** — fast, consumer gets result in response (e.g., simple lookup, summary)
- **Background** — long-running, consumer gets taskId, result delivered via callback/store
- **Mixed** — some actions foreground, some background

### 5. Error Reporting
All pre-analysis errors returned synchronously before any work starts:
```json
{
  "status": "rejected",
  "errors": [
    {"action": "post to JIRA", "reason": "JIRA URL not provided"},
    {"action": "send email", "reason": "agent does not have email capability"}
  ],
  "valid_actions": [
    {"action": "analyze dump", "mode": "can execute"}
  ]
}
```

## Open Design Questions

### 1. result_sender: Universal HTTP Tool (Decision: Option A)

**Decision: Universal `result_sender`** — single MCP tool that handles any HTTP destination.

**Why not plugins/per-destination tools:**
- BTP has no filesystem for runtime plugins — everything must be deployed as part of the app
- Separate microservices per destination (JIRA service, Slack service) is massive overhead
- Adding a new destination would require redeployment

**How LLM knows API formats:**
- RAG facts store contains examples for common APIs (JIRA REST, Slack webhook, OData, etc.)
- New destinations are added by upserting RAG facts, not by deploying code
- LLM reads the RAG-provided examples and constructs the correct request

**Example RAG fact for JIRA:**
```
To post a comment to JIRA issue, use result_sender with:
- url: https://{instance}.atlassian.net/rest/api/3/issue/{issueKey}/comment
- method: POST
- headers: {"Authorization": "Basic {base64(user:token)}", "Content-Type": "application/json"}
- body: {"body": {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "{comment}"}]}]}}
```

**Adding new destinations = adding RAG facts, not code.** This is the key advantage on BTP.

### 2. Background Task Lifecycle

- **Storage**: in-memory Map (simple) vs persistent DB (reliable)?
- **TTL**: how long to keep completed tasks?
- **Timeout**: max background execution time?
- **Retry**: if result_sender fails, retry? How many times?
- **Cleanup**: periodic sweep of expired tasks?

### 3. Security

- **URL allowlist**: should result_sender be restricted to known domains?
- **Credential forwarding**: how does background agent authenticate to external APIs?
  - Consumer provides credentials in request?
  - Pre-configured per destination in BTP Destination service?
  - OAuth2 token exchange?
- **Audit**: log all external calls for compliance?

### 4. Where Does This Live?

| Component | Location | Reason |
|-----------|----------|--------|
| `run_background` | cloud-llm-hub | Lifecycle management is deployment-specific |
| `result_sender` | cloud-llm-hub MCP tool | Universal HTTP tool, deployed with the app |
| Pre-analysis pipeline stage | llm-agent | Extends classifier/assembler stages |
| Task status store | cloud-llm-hub | Deployment-specific persistence |
| Destination knowledge | RAG facts | API format examples, added without code changes |

### 5. OData Surface

The OData endpoint remains the consumer-facing API:

```cds
service AgentService {
  action Submit(request: AgentRequest) returns AgentResponse;
  function TaskStatus(taskId: UUID) returns TaskInfo;
  function TaskResult(taskId: UUID) returns TaskResult;
  action CancelTask(taskId: UUID) returns { success: Boolean };
}
```

- `Submit` — unified entry point, agent decides sync/async
- `TaskStatus` — poll for background task progress
- `TaskResult` — retrieve result (if stored, not sent via callback)
- `CancelTask` — abort a running background task

## Implementation Phases

### Phase 1: Synchronous OData Submit
- `Submit` action with sync-only mode
- Pre-analysis: capability check + info sufficiency
- No background processing yet

### Phase 2: Background Processing
- `run_background` MCP tool
- Task status store (in-memory)
- `TaskStatus` / `TaskResult` endpoints

### Phase 3: Result Delivery
- `result_sender` MCP tool (universal HTTP)
- Security: URL allowlist, credential management
- Audit logging

### Phase 4: Destination Knowledge Base
- RAG facts for common APIs: JIRA, Slack, ServiceNow, S/4HANA OData
- Adding new destinations = upserting RAG facts, no code changes
- No plugins needed — universal result_sender + RAG knowledge is sufficient on BTP
