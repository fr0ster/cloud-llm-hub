# Dialogue planner prompt: core, planner skills, RAG skills

Status: draft (design only, no code yet)
Date: 2026-10-24

## Problem

The dialogue planner leads every long session: it plans, delegates to
workers, checks results and talks to the user. Its system prompt is one flat
text: about 30 rules from llm-agent (`DIALOGUE_PLANNER_SYSTEM`) plus about 15
hub rules (`HUB_DIALOGUE_STORAGE_RULES` and the additions in
`HUB_DIALOGUE_PLANNER_SYSTEM`). Every rule applies to every request, whatever
the task.

Live tests on the POC (ST22 dump analysis, one stored record per dump, a
counted check and a summary) showed what this costs:

| Failure | Sonnet 4.5 | Opus 4.6 |
|---|---|---|
| Guessed missing facts (assumed the year 2024 when the request said "24.10") | yes | no |
| Asked for agreement only in text, so the answer did not count as consent (two extra rounds) | yes | no |
| Claimed "delegated the checker" and wrote its own `[actions]` line, without a tool call; the plan stalled | yes, twice | no |
| Stored the user's results with session scope instead of user scope | n/a | yes |
| Finished the plan without help | no | yes (~8 min) |

Some of this is model strength: llm-agent 30.9.1 enforces the plan
invariants, and hub 9.3.0 adds `LLM_AGENT_PLANNER_MODEL`. But the prompt is also
part of the problem. Rules that matter only for one kind of task, such as
batch item lists or RAG storage scopes, crowd out the invariants that matter
everywhere. Weaker models then drop some rules and copy others literally.

## Goals

1. A short, stable core that every planner turn obeys.
2. Task-specific planning guidance chosen per request, not always present.
3. Guidance that admins (and later users) can extend without a deploy.
4. Explicit handling of missing information: ask, never guess.
5. Measurable: the same scenarios pass on the executor-class model and on a
   stronger planner model.

Non-goals: changing the plan data model or the enforcement in llm-agent;
changing worker (executor/checker) prompts beyond one "ask, don't guess" rule.

## Design

### Layer 0: environment note (every turn, generated)

The `[environment]` note gets the facts the planner currently guesses:

- current date and time with time zone (server clock);
- concurrency limit and worker tool-call budget (already partly present);
- configured `maxItemsPerStep`, when set.

### Layer 1: core system prompt (llm-agent, short)

Only invariants, written once, kept under about 15 lines:

- Role: lead the dialogue, plan, delegate, check; state what to achieve, not how.
- Truth sources: `[plan]` and `[actions]` are written by the system. A
  delegation, check or update exists only after its tool call succeeded in
  this turn. Never write `[actions]`, `[plan]` or `[check]` lines yourself.
- Plan shape: stable step ids, result goals, `dependsOn`; always `step_id`
  on delegation.
- Missing information: when a step needs a fact the request and the
  environment do not give (scope, dates, target system, where to store,
  acceptance criterion), set `waiting_user` with one concrete question. Never
  assume a value.
- Consent: skipping, removing or narrowing needs a user answer after
  `waiting_user`; asking in plain text does not count.
- Checks: checker-owned checks close only with a checker verdict.
- Turn discipline: never wait inside a turn; `NO_MESSAGE` on event turns
  with nothing to tell; reply in the user's language.

All other current rules move to skills or are dropped (see the inventory).

### Layer 2: planner skills (hub, in code)

A separate skill pool for the planner, `srv/planner-skills/<name>/SKILL.md`
(same format as `srv/skills`: frontmatter `name`, `description`, body).
Planned initial set:

| Skill | Content (moved from today's prompt or new) |
|---|---|
| `planning-batch-processing` | "process all X": list identifiers page by page, one step per item (or items + counted check), batches of about 20 steps, split to fit worker budgets, final count check |
| `planning-stored-results` | storing means hub RAG (`rag_add`), user scope for results the user asks to keep, session scope only for scratch data, the check reads records back and verifies count and scope |
| `planning-clarification` | what to ask before planning: time ranges with full dates, scope limits, target system/destination, storage target, output format; one question at a time |
| `planning-sap-changes` | do not create/change/activate objects unless asked; reading tasks only read; sequence steps touching the same object, lock or transport |
| `planning-dump-analysis` | ST22 specifics: filter by date range, verify the dump timestamps, per-dump record fields |
| `planning-rap-object` | RAP object creation order and activation groups (references the executor skills) |

Selection: the planner gets its own `ISkillManager` and its own tools-RAG
store holding the vectorized planner skills (`skill:<name>`), queried with the
user request plus the current plan goals. At most 2 skills per turn.

Constraint found in llm-agent (`rag-orchestrator.ts`): with `mode: 'hard'`
(the planner's mode) and no RAG match, *all* skills are injected. The planner
pool therefore needs either a library option "no match, no skills" or a
planner mode where skill injection uses a top-k without the inject-all
fallback. This is an llm-agent change (draft PR when implementation starts).

### Layer 3: RAG-backed planner skills (hub, no deploy)

A global collection `planner-skills` (admin write, everyone read, the same
`canAccess` rules as other global collections). Each document is one skill in
the `SKILL.md` format. The hub composes in-code planner skills and RAG skills
with `CompositeSkillManager`; in-code skills win a name clash, matching the
executor pool rule. Later, a user-scope collection can extend a user's own
planner without affecting others.

Documents are vectorized like any RAG document; the planner skill query searches
both stores. Changes take effect on the next planner turn without a deploy.

## Inventory of current rules

Legend: **C** core, **S:name** move to a skill, **E** environment note,
**X** drop (enforced by code or duplicated).

Library (`DIALOGUE_PLANNER_SYSTEM`):

| Rule | Target |
|---|---|
| Lead dialogue, planning, delegation and control; what, not how; no ABAP details | C |
| Complex declarative requests: specification before planning | S:planning-clarification |
| Workers are listed in the delegate_task schema | X (schema) |
| Concurrency limit (hub removes and replaces) | E |
| Parallel only when independent; sequence same object/lock/transport | S:planning-sap-changes |
| `[plan]` is the board truth; task exists only after delegate_task | C |
| `[actions]` written by the system; never claim unconfirmed actions | C (plus "never write these lines") |
| `[check]` note meaning | C (short) |
| update_plan / get_plan usage | X (tool descriptions) |
| Step ids, result goals, dependsOn, step_id, dependencies before delegation | C |
| Existing ids keep state; state overrides | X (tool description) |
| Skip/remove/narrow needs consent | C |
| Items + counted checks, batch split, ~20 steps per update | S:planning-batch-processing |
| Check lifecycle (planner vs checker, JSON verdict, count) | C (one line) + tool description |
| waiting_user with a question | C (merged into "missing information") |
| get_task/list_tasks, stop_task | X (tool descriptions) |
| After results: continue, correct, re-delegate, ask | C |
| Never wait inside a turn; NO_MESSAGE; [restart] handling; user's language | C |

Hub additions:

| Rule | Target |
|---|---|
| Storage rules (RAG, scopes, no SAP changes, read back, ambiguous storage → ask) | S:planning-stored-results, S:planning-sap-changes |
| Steps state results, workers choose tools | C |
| Smallest checkable result; process-all pattern | S:planning-batch-processing |
| delegate_task brief contents; worker sees only the brief | C (short) |
| Ask before narrowing scope; a [check] note is not agreement | C |
| One item per step; rag_list count check | S:planning-batch-processing |
| Checker can read RAG with rag_list | S:planning-stored-results |
| Language of goals and questions | C |
| [task events]/[restart] are not the user | C |

## Workers

One added sentence for executor and checker prompts: "If the brief lacks a fact
you need (a date, a scope, an id), do not assume it: return what is missing as
the result." The planner turns that into a `waiting_user` question.

## Validation

Acceptance runs on the POC through the WebUI, and again through a plain
OpenAI client and an Anthropic client, matching the client-agnostic protocol
requirement:

1. Dump scenario with an ambiguous date ("24.10" without a year) and with a
   full date. Expected: a question about the year or the correct year from
   the environment note; no guessed year.
2. Dump scenario, 10 items: the plan finishes without user nudges, records
   are stored with user scope, the checker verifies count and scope.
3. Narrowing request: one formal `waiting_user` round, consent accepted.
4. RAP object creation scenario (exercises a domain planning skill).
5. A RAG planner skill added by an admin changes the plan on the next turn
   without a deploy.

Each scenario runs with the planner on the executor-class model (Sonnet 4.5)
and on a stronger planner model (Opus 4.6), recording completion, user nudges,
time and token use.

## Rollout

1. llm-agent: core prompt rewrite, environment date, "never write system
   lines", no-match-no-skills option; release.
2. Hub: planner skill pool and in-code skills; move hub rules out of the
   prompt; release; POC acceptance runs.
3. Hub: RAG-backed planner skills collection; release; acceptance run 5.

## Open questions

- Should RAG planner skills be global only (admin) at first, or user scope
  from the start?
- Should the 2-skill cap be configurable (for example
  `LLM_AGENT_PLANNER_SKILLS_K`)?
