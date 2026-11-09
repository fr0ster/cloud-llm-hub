# Session role models and parameters — design

<!-- docs-check:proposed-env: stage 2 names (LLM_AGENT_PLAN_STEP_BUDGET) are not implemented yet -->

Status: draft, 2026-11-09.

## Intent

The hub is in test operation. The user measures how well prompts and skills
work and compares runs. For that the user must be able to set, on the fly,
which model each agent role uses and with which model parameters, for one
session, from every channel the hub serves.

Today:

- the request `model` becomes the coordinator model (allowlist checked);
- the plan author model comes only from `LLM_AGENT_PLANNER_MODEL` (deploy);
- executor and checker models are chosen by the coordinator (`delegate_task`
  `model`) or fall back to the deploy model;
- the only model parameters are global `LLM_AGENT_TEMPERATURE` (0.7) and
  `LLM_AGENT_MAX_TOKENS` (2000), the same for every role; max tokens can never
  be left out, and there is no reasoning parameter at all;
- the WebUI toolbar has an `LLM` select (it feeds the request `model`, so the
  coordinator), a `CLASSIFIER` select whose value no server code reads, and
  read-only `EMBEDDER` and `PLANNER` labels;
- the WebUI does not show which model actually runs. On the POC (2026-11-09)
  `LLM` showed Sonnet while the coordinator ran on Opus.

## Goals

1. Per session, the user can set the model of each role: **coordinator,
   planner (plan author), executor, checker**.
2. Per session and role, the user can set every parameter the chosen model
   supports. Every limit (max output tokens, reasoning budgets) can be
   switched off.
3. A role with no user setting behaves as today:
   - the coordinator chooses the executor and checker models from the
     allowlist;
   - the planner uses `LLM_AGENT_PLANNER_MODEL` or the deploy model;
   - the coordinator model is the request model, then
     `LLM_AGENT_COORDINATOR_MODEL`, then the deploy model.
4. The same settings are reachable from the WebUI, the OpenAI- and
   Anthropic-compatible APIs, and the agent MCP.
5. A run can be compared afterwards: the usage ledger shows, per LLM call, the
   model and the parameters in effect.
6. Per session, the user can set or switch off the execution budgets and
   limits, without a deploy and without `cf set-env`. The user's words: they
   need to test this, and deploying every time is inconvenient.
7. **Parity.** Everything the WebUI window can set (role models, model
   parameters, execution limits) can also be set through the deploy
   configuration, the chat API headers and the agent MCP. No channel has a
   setting the others lack.
8. **Admin only.** Only a user with the `MCP_Admin` role may change these
   settings, on every channel.

## Non-goals

- Changing how the classifier works or making the embedder selectable.
- Changing defaults for other sessions or for the deployment.
- Cost coefficients per model.

## Anti-goals

- A setting of one session reaching another session (session isolation is
  guaranteed; no shared or implicit fallback).
- A silent fallback: a model or parameter the hub cannot apply must be
  reported to the caller, never quietly replaced.
- A hidden limit during measurements: when the user switches a limit off,
  the hub must not send a value of its own (the 2000-token default included).
- New required configuration. Only `LLM_AGENT_MODEL` stays required.

## Decisions (the user's)

- **Lifetime.** A setting holds until the end of the session, until the user
  changes it, or until a hub restart. After a restart the session is back on
  defaults.
- **Who wins.** A user setting for a role overrides the coordinator's choice
  for that role (the `delegate_task` `model` and a profile `model`). Without a
  user setting the coordinator keeps choosing.
- **Parameters.** The settings show all parameters the chosen model supports.
  Max output tokens and budgets can be set or switched off.
- **WebUI.**
  - The `LLM` select in the toolbar is replaced by an `LLM` button next to
    `MANAGE`.
  - Like `MANAGE`, the button opens a window: models and parameters for
    coordinator, planner, executor and checker.
  - A model picker at login or session start was mentioned as an alternative.
    The window is the chosen form.
- **OpenAI / Anthropic APIs.** Settings travel in request headers. Clients are
  the user's scripts, Cline and goose; all can send headers.
- **Agent MCP.** Settings are arguments of `session_open`, and a separate tool
  changes them later. There is no hub coordinator on this channel (the
  connecting agent coordinates), so the roles there are planner, executor and
  checker.

## Design

### Session settings

One typed object per session, held with the session (not in the global
config and not in any process-wide cache):

```
RoleModelSettings = {
  coordinator?: RoleSetting;
  planner?: RoleSetting;
  executor?: RoleSetting;
  checker?: RoleSetting;
}
RoleSetting = {
  model?: string;                // allowlisted model id; absent = default
  params?: ModelParams;          // absent field = model/provider default
}
ModelParams = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number | 'off';
  reasoning?: ReasoningSetting;  // shape per model family, see below
}
```

- `'off'` means the hub sends no limit of its own.
- A field that is absent means: today's value. That is the global
  `LLM_AGENT_TEMPERATURE` / `LLM_AGENT_MAX_TOKENS` default where the hub sends
  one today, else nothing. A model-only setting therefore runs exactly as
  today's runs, apart from the model. The settings window and
  `GET /v1/session/models` show these effective values, so nothing applies
  unseen. (My call: keeps runs comparable with earlier ones.)
- `params` require an explicit `model` in the same role. Parameters with
  "auto" are refused: the coordinator picks the model later, and the
  parameters could not be checked against it. (My call.)
- Settings are not written to the dialogue state store, so a restart drops
  them (user decision). The existing `coordinatorModel` persistence stays for
  the request-model path.
- Validation is one function shared by all channels: unknown role, model not
  on the allowlist, parameter the model does not support, value out of range
  → the whole update is refused with a reason that names the field. Nothing
  is partly applied.

### Where each role takes its setting

- **Coordinator.** The coordinator LLM (`coordinatorModel` ALS,
  `preparePlanner` in `srv/lib/dialogue-sessions.ts`) uses
  `settings.coordinator` when present, else today's request/deploy model.
- **Planner (plan author).** `buildPlannerAgent` (`srv/agent-manager.ts`) uses
  `settings.planner` for the `planner-author` component, else
  `LLM_AGENT_PLANNER_MODEL` / deploy model. The chat planner keeps following
  the coordinator.
- **Executor and checker.** `createWorker`
  (`srv/lib/agent-profile-runner.ts`) resolves the model as: user setting for
  the worker's role → `delegate_task` `model` → profile `model` → deploy
  model. The checker is the profile with `result: verdict`; every other
  worker profile counts as executor. (My call; the builder may map by profile
  name if that proves cleaner.)
- **llm-agent internal roles.** These are the SmartAgent's own planner,
  reviewer, finalizer and helper calls.
  - Inside a worker, they follow that worker's role setting: executor or
    checker.
  - On the coordinator path (including the chat planner), they follow the
    coordinator setting.
  - The classifier keeps its own setting.
  - The same mapping fills the `role` field in the ledger. (My call.)
- When the user setting overrides a coordinator choice, the task record and
  the coordinator's tool result say which model ran, so the coordinator does
  not retry or argue.

### Parameters per model

There is no source today of which parameters a model supports: AI Core
catalogue entries carry only capabilities, context length and streaming. The
hub keeps a typed capability table per model family (Anthropic Claude, OpenAI
GPT/o-series, Google Gemini, Mistral and others the allowlist uses), listing
the supported parameters, their ranges and whether a limit may be left out.

- **Anthropic.** The Messages API requires `max_tokens`. For `'off'` the hub
  sends the model's maximum output, never a smaller hub default. Thinking:
  enabled/disabled plus budget tokens, or the effort form where the model
  takes it.
- **OpenAI reasoning models.** `reasoning_effort`; `max_completion_tokens`
  may be omitted.
- **Through SAP AI Core orchestration.** Unset values are already left out by
  the provider.

Library gaps (llm-agent): per-role `CallOptions` are not passed to planner,
reviewer or finalizer roles; there is no reasoning option; the Anthropic
provider always sends `max_tokens ?? 4096`. These go to llm-agent as a draft
PR first, then the hub uses them (the hub composes llm-agent parts; a missing
part is added in llm-agent).

The LLM cache key (`hubLlmKey`) must include the parameters, so two sessions
with different settings never share a client.

### Channels

**Read and write API (shared).**

- `GET /v1/session/models` (with `x-clh-session`): the session's settings,
  the effective model per role, and for each allowlisted model its parameter
  capabilities.
- `PUT /v1/session/models`: replaces the settings; validation as above.
- `GET /v1/models` keeps its shape and adds the capability table, so clients
  without a session can read it.

**WebUI** (`app/chat/webapp/index.html`).

- Toolbar: the `LLM` select becomes an `LLM` button next to `MANAGE`. The
  read-only `PLANNER` label moves into the window. `CLASSIFIER` and
  `EMBEDDER` stay as they are. (My call.)
- The window has one block per role. Each block has:
  - a model select, whose first entry is "auto" (coordinator chooses; for the
    coordinator itself: deploy default);
  - fields for the parameters the selected model supports;
  - an "off" switch on every limit.
- Save calls `PUT /v1/session/models`; opening the window calls
  `GET /v1/session/models`. A refusal shows the server's reason at the field.
- The chat request no longer sends the toolbar `model`; the coordinator comes
  from the session settings.

**OpenAI- and Anthropic-compatible APIs.**

- Headers per role: `x-clh-model-coordinator`, `x-clh-model-planner`,
  `x-clh-model-executor`, `x-clh-model-checker`; parameters as JSON in
  `x-clh-params-<role>`. The value `auto` clears a role.
- Headers are sticky: a request that carries them updates the session's
  settings (same validation, same all-or-nothing rule); later requests
  without them keep the settings.
- The body `model` keeps selecting the coordinator as today. When both the
  body `model` and `x-clh-model-coordinator` are present, the header wins.
  (My call.)
- A refused header fails the request with 400 and names the field. Today's
  `x-clh-model-ignored` stays only for the body `model`, which clients such as
  Cline fill with whatever their model list shows.
- Every response carries `x-clh-models-effective` with the effective model
  per role, so scripts can log what ran.

**Agent MCP** (`srv/agent-mcp.ts`).

- `session_open` takes optional `models` with `planner`, `executor`,
  `checker` (each `RoleSetting`).
- A new tool, `session_set_models`, with arguments `{ session, models }`,
  replaces them for an open session and returns the effective settings.
- A `coordinator` entry is refused on this channel with a reason (the
  connecting agent is the coordinator).
- What each role controls on this channel:
  - `executor`: `execute_step`, and executor delegations through
    `delegate_task`;
  - `checker`: checker delegations through `delegate_task`;
  - `planner`: plan authoring through `plan_create` / `plan_revise`.
  - The setting has effect wherever that tool runs, so none is accepted
    without effect.
  - The builder verifies each path. A role whose path does not exist on this
    channel is refused, not ignored.
- The tool is listed with the other session tools for users with
  `MCP_Admin` only (see Admin role).

### Execution limits

The user can set or switch off the execution budgets and limits for one
session, next to the models. They are not model parameters, so they are a
separate section of the same settings:

```
ExecutionLimits = {
  maxIterations?: number | 'off';      // LLM_AGENT_MAX_ITERATIONS, default 10
  maxToolCalls?: number | 'off';       // LLM_AGENT_MAX_TOOL_CALLS
  toolResultMaxChars?: number | 'off'; // LLM_AGENT_TOOL_RESULT_MAX_CHARS
  historyTokenBudget?: number | 'off'; // SessionManager tokenBudget, 8000 today
  planStepBudget?: number | 'off';     // llm-agent run and plan-step budgets
}
```

- Per role where the limit is per run (`maxIterations`, `maxToolCalls`): the
  coordinator, executor and checker each have their own value. Session-wide
  for the others. (My call.)
- `'off'` means no limit from the hub. A run then ends when the work ends,
  when the user stops it (`stop_task`, closing the session), or at a real
  external limit (the provider's context window). No timeout replaces the
  limit.
- An absent field keeps today's value (env or built-in default), shown as the
  effective value.
- The same validation, lifetime (until the session ends, the user changes it,
  or a restart) and all-or-nothing rule as for models.
- Channels:
  - WebUI: a "Limits" section in the `LLM` window.
  - Chat APIs: a sticky `x-clh-limits` header (JSON, merged field by field).
  - Agent MCP: `limits` in `session_open` and `session_set_models`.
- Limits the hub owns (`maxIterations`, `maxToolCalls`,
  `toolResultMaxChars`, `historyTokenBudget`) come in stage 1. Limits owned
  by llm-agent (run and plan-step budgets, `maxItemsPerStep`) come in
  stage 2. Until then they are refused with a reason, not ignored.

### Deploy configuration (parity)

Every session setting has a deploy-level counterpart. It is the default for
all sessions, and a session setting overrides it. All of them are optional
and unset by default; only `LLM_AGENT_MODEL` stays required.

| Setting | Configuration |
|---|---|
| coordinator model | `LLM_AGENT_COORDINATOR_MODEL` (exists) |
| planner model | `LLM_AGENT_PLANNER_MODEL` (exists) |
| executor model | `LLM_AGENT_EXECUTOR_MODEL` (new) |
| checker model | `LLM_AGENT_CHECKER_MODEL` (new) |
| role parameters (stage 2) | `LLM_AGENT_<ROLE>_PARAMS`, JSON `ModelParams` (new) |
| run limits per role | `LLM_AGENT_<ROLE>_MAX_ITERATIONS`, `LLM_AGENT_<ROLE>_MAX_TOOL_CALLS` (new); the existing `LLM_AGENT_MAX_ITERATIONS` / `LLM_AGENT_MAX_TOOL_CALLS` stay as the fallback for every role |
| tool result size | `LLM_AGENT_TOOL_RESULT_MAX_CHARS` (exists) |
| history token budget | `LLM_AGENT_HISTORY_TOKEN_BUDGET` (new; today a fixed 8000) |
| plan-step budget (stage 2) | `LLM_AGENT_PLAN_STEP_BUDGET` (new) |

- Every limit variable accepts `off`.
- A configured executor or checker model acts like the same WebUI setting:
  it overrides the coordinator's choice for every session. Unset, the
  coordinator chooses. (My call: the configuration means exactly what the
  window means.)
- Invalid values are refused at startup with the variable name, as other
  configuration is today. A configured model outside the allowlist is an
  error, not a silent fallback.
- Changing configuration on the POC is still a `cf set-env` plus restart,
  each needing the user's approval. The session settings are the way to
  change things without that.

### Admin role

- **Who may change settings.** Changing models, parameters or limits needs
  `MCP_Admin` (`xs-security.json`; checked as `user.is('MCP_Admin')`).
- **Per channel:**
  - WebUI: for an admin the `LLM` window is editable. Without the role the
    same button opens the window as information only: effective models,
    parameters and limits with their source, all fields read-only, no Save.
    (The user's decision.)
  - `PUT /v1/session/models`: 403 for a non-admin (`requireAdminRole` exists
    and is not mounted yet).
  - Chat API role and limit headers from a non-admin: 403 naming the header,
    so nothing is stored.
  - Agent MCP: `session_set_models` is listed only for a user with
    `MCP_Admin`. Other users do not see it, and a direct call is refused as
    an unknown tool. (The user's decision; it is a deliberate exception to
    "the same tool set on every connection".) For the same users the
    `models` / `limits` arguments of `session_open` are left out of its
    schema, and they are refused if sent anyway. (My call, to match the
    tool rule.)
- **Body `model` too.** The request body `model` (OpenAI and Anthropic, the
  WebUI included) selects the coordinator only for an admin. For any other
  user it is ignored: the session keeps its coordinator, and the response
  carries `x-clh-model-ignored`, as for a model outside the allowlist. Such a
  request does not fail, because clients like Cline always send `model`.
  (The user's decision.)
- **Body parameters too.** The same rule covers the body's model parameters
  (`temperature`, `top_p`, `max_tokens` / `max_completion_tokens`,
  `reasoning_effort`, Anthropic `thinking`). The hub reads none of them today.
  - From an admin, in stage 2, they become the coordinator's parameters for
    this request, validated against the model's capabilities like the
    `x-clh-params-coordinator` header.
  - From any other user they are ignored, and the response carries
    `x-clh-params-ignored` with the ignored names. The request does not fail.
  - In stage 1 they are ignored for everyone and reported the same way,
    because parameters per role need llm-agent. (The user's decision for
    non-admins; the staging is my call.)
- **Reading.** `GET /v1/session/models` and the `x-clh-models-effective`
  header stay readable for every user of the session, so everyone sees which
  model and limits run. (My call.)
- **An admin changes only their own session.** The admin role grants no
  access to another user's session.

### Usage ledger

Each `llm.call` record gets the effective parameters (temperature, top-p,
max output tokens or `off`, reasoning setting) next to the model it already
stores, and the role. This is an llm-agent usage schema addition, done in the
same llm-agent draft PR. Nothing is analysed by the hub; the ledger only
stores. (My call: comparing runs needs to know which parameters were in
effect.)

## Constraints

- Static typing everywhere: no `any`, no `unknown` outside narrowed caught
  errors, no `as unknown as`, no `as never`.
- No timeouts introduced.
- Session isolation: settings are keyed by the session that the caller owns;
  no cookie, shared storage or empty header may attach them to another
  session.
- Same tool set on every agent MCP connection, except `session_set_models`,
  which only `MCP_Admin` users see.

## Left to the builder

- The exact header names beyond the pattern above, the JSON shape of
  `x-clh-params-<role>`, and the error texts.
- How the capability table is organised (by family with per-model
  overrides is expected), as long as unknown models get no parameter fields
  rather than guessed ones.
- WebUI layout inside the window.
- Splitting the work into PRs within the two stages below.

## Stages

llm-agent releases go: version PR → signed tags → the user publishes to npm.
The hub cannot depend on an unpublished llm-agent, so the work comes in two
stages.

1. **Hub only.**
   - Settings store and validation.
   - `GET`/`PUT /v1/session/models`.
   - The WebUI window: models for all four roles. Parameter fields show the
     effective values read-only until stage 2.
   - Headers.
   - `session_open` `models` and `session_set_models`.
   - The model per role on all paths.
   - The execution limits the hub owns, with "off".
   - The capability table.
   - Every channel accepts `params` already, but stage 1 refuses them with a
     reason ("parameters per role need llm-agent X"). They are never accepted
     without effect.
2. **After the llm-agent release.**
   - Per-role `CallOptions` on every role.
   - Reasoning settings.
   - `'off'` for max tokens (Anthropic provider included).
   - Ledger parameters.
   - Run and plan-step budgets owned by llm-agent.
   - The hub then enables `params`.
