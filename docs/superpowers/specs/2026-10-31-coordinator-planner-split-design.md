# Coordinator and planner split

Status: implemented, 2026-10-31. Roadmap item 2a. Library parts go to llm-agent, configuration and transport to the hub.

## Why

Today one LLM, the dialogue planner, does everything in one context: it talks to the user, creates and revises
the plan, delegates tasks, tracks them and reacts to checks. Two problems follow:

- **Tokens.** Every dialogue turn carries the full planning prompt (the `planner` profile, ~10 KB, plus library
  protocol guidance and per-turn notes) even when the turn is a short reply.
- **Mixed prompts.** Conversation rules and planning rules live in one system prompt and pull against each other.

No other defect is known that this change must fix.

## What changes

The dialogue LLM becomes the **coordinator**. Plan authoring moves to a separate, stateless **planner**.

### Coordinator

- Talks to the user and is the only component that does.
- Holds the session plan (in session state, as today).
- Every action is a call to a tool of the **orchestration tool set** (below). Choosing the next action means
  choosing a tool; there is no fixed action list. Replies and questions to the user are its ordinary text output,
  not a tool.
- Edits the plan itself for small changes (mark a step skipped, reorder, add a note, adjust a goal) through
  `plan_update`. It calls the planner to create a plan or to rework it substantially. Where the line lies is the
  coordinator LLM's judgement; no hard rule.
- Does not run SAP steps itself.
- Its system prompt covers conversation and orchestration only. Planning rules leave it.

### Planner

- Stateless: one call in, one plan out. It keeps nothing between calls.
- Two modes, each with its own system prompt:
  - **create:** brief → plan;
  - **revise:** current plan + step states and results + what changed → revised plan.
- Sees the brief, not the conversation. The brief must be complete enough to plan from; references to records,
  collections and attachments go in it as ids.
- One planner per call for now. Later the coordinator may run several planners and pick the best plan; nothing in
  the brief or result format may prevent that (they are plain data, no session handles inside).
- Has no SAP tools. If planning needs a look at the system, the plan contains a read step for an executor.
- Has read-only knowledge tools (user decision): `rag_search`, `rag_read`, `collection_records`,
  `collections_list`, under the same profile ceilings. So the brief carries references (record, collection,
  attachment ids) and the planner reads what it needs; the planner is a tool loop through the profile runner, not a
  single completion. Today's planning knowledge (planner retrieval, planner memory) moves to the planner.
- Model: the existing planner model setting. The planner model is never weaker than the executor model.

### Executors and checker

Unchanged: up to 3 executors in parallel per session (`LLM_AGENT_DIALOGUE_EXECUTORS`), shared pool across
sessions, checker profile with `result: verdict`, honesty reviewer, profile tool ceilings.

## Orchestration tool set

One tool set, the same for every client: our coordinator (internal), and external agents over agent MCP
(Claude Code, Codex, Copilot) that take the coordinator's place. This follows the binding rule "tools are the same
for every connection" already applied to RAG; profile ceilings and the agents-collection exclusion still apply.

| Group | Tools | Notes |
|---|---|---|
| Planning | `plan_create`, `plan_revise` | Call the planner. Return the plan. With a session, the result also becomes the session plan (see Open points). |
| Plan state | `plan_get`, `plan_update` | Session plan; `plan_update` edits it without an LLM call. |
| Execution, async | `delegate_task`, `get_task`, `list_tasks`, `stop_task` | Existing dialogue task tools; tasks run in the background under the session limits. |
| Execution, sync | `execute_step` | Existing agent MCP tool; waits and returns the executor's result. |
| Knowledge | the 11 canonical RAG tools | Unchanged. |
| Environment | `list_destinations`, `session_open`, `session_close` | Unchanged. |

Both the async and the sync execution tools are offered to every client (better an extra tool than a missing
one): the coordinator mostly uses the async ones so the dialogue never blocks; an external agent may prefer
`execute_step` and parallel calls of its own.

**Where plan and tasks live for an external agent (user decision).** A session opened over agent MCP
(`session_open`) gets the same plan and task board as a dialogue session, but without a coordinator LLM: the
external agent is the coordinator. The plan-state and async execution tools (`plan_get`, `plan_update`,
`delegate_task`, `get_task`, `list_tasks`, `stop_task`) need a session key; without one they return
`SESSION_REQUIRED`, like the RAG tools. `plan_create` / `plan_revise` and `execute_step` also work without a
session (they return the plan or result and store nothing). This needs a new llm-agent entry point that runs the
task board and plan without an LLM turn (today `PlannerToolsClient` only works inside a planner turn). The board
and plan are the session's state, persisted like dialogue state; this is not a separate task API.

`execute_step` and `delegate_task` both name the worker profile (executor, checker, analyst, …), so an external
agent can run a check the same way the coordinator does.

The remaining library planner tools (`deliver`, `new_request`, `get_plan`, `search_knowledge`, `update_plan`) are
folded into this set or kept as they are; the builder maps them, keeping behaviour.

## Prompts and profiles

- New profile records in the `agents` collection: `coordinator`, `planner-create`, `planner-revise` (names are the
  builder's call). Seeded like today's `planner` / `executor` / `checker` records, required at startup.
- The current `planner` record is split: conversation/orchestration rules → `coordinator`; planning rules →
  the two planner records. Hub additions (brief/goal rules, batch paging, scope-narrowing consent, check
  read-back, request language, task events, profile selection, record_add usage) go where they belong.
- Per-turn notes (environment block, worker profiles, plan view, budgets, attachments, memory) go only to the
  component that uses them.

## Library and hub split

- **llm-agent:** coordinator mode of `DialogueSession`; planner component (stateless, create/revise, typed
  brief/result); `plan_create` / `plan_revise` / `plan_update` tools in the planner tools client, backed by an
  injected planner interface. Released by the usual order (version PR, Claude pushes tags, the user publishes).
- **Hub:** profile records and seeds, wiring the planner through the profile runner, exposing the orchestration
  tool set on agent MCP, configuration, migration, docs.

## Behaviour that must not change

- WebUI and the OpenAI / Anthropic protocols: same plan and task events, same TASKS panel, same turn/follow
  delivery.
- Limits, checks, honesty reviewer, consent rules, session lifetime, SAP connection per executor.

## Success and failure

- **Success:** the coordinator prompt is conversation-only; the planner prompts are planning-only; on the same
  scenarios the coordinator's tokens per turn drop and the total tokens per scenario do not grow.
- **Failure even if it works:** total tokens grow because of the extra planner call; or plans get worse because
  the brief loses detail the conversation had.
- **Measurement:** a one-off before/after comparison of the same scenarios from the usage records (store only; no
  analytics feature).

## Migration

- Bump `DIALOGUE_TOOL_CONTRACT_VERSION`. The `Plan` structure stays, so saved plans are kept if the builder can map
  them; otherwise the existing migration path applies (unfinished tasks interrupted, steps blocked, replan note).
- Release as a minor version unless a client-visible tool is removed or renamed; then major.

## Open points (builder's call unless marked)

- Exact tool names and schemas; whether `plan_create` / `plan_revise` with a session write the session plan
  directly or only return it (with `plan_update` to store). Keep the sync/async pair either way.
- Models (author's call): `LLM_AGENT_PLANNER_MODEL` today drives the dialogue LLM. After the split it drives both
  the coordinator and the planner by default, so no deployment silently changes the model that talks to the user.
  Separate coordinator / planner-author variables are optional and unset by default (only `LLM_AGENT_MODEL` may be
  required). "Planner not weaker than executor" stays a deployment rule, not a startup check.
- Brief shape: goal, constraints, environment facts, worker profiles, knowledge references; the builder fixes the
  type.

## Non-goals

- Several planners per call with selection (later).
- Changing executor, checker or RAG behaviour.
- A server-side task API with its own state beyond the session's plan and task board.
