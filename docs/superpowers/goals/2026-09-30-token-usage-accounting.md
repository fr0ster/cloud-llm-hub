# Goal: token usage accounting per user

<!-- docs-check:proposed-env — this goal names configuration that does not exist
     yet, by design; the env-name check is skipped here. -->

> **Owned by the user.** This document changes only when the user explicitly
> says so or agrees to a proposed change. The spec, the plans and the code
> follow it; they never edit it.
>
> **Status: draft, parked.** Brainstorming is paused while the repository is
> prepared for publication. One question is open; see the end.

## The task

`GET /v1/usage` today is the in-process request-logger summary of the default
agent: it resets on restart, has no per-user split, and does not persist.

## Goals

1. Know how many tokens each user spent, per model, over a period.
2. Keep the records across restarts and deploys.

## Decisions

| Date | Decision |
|---|---|
| 2026-09-30 | Purpose: internal cost control. No quotas, limits or billing. |
| 2026-09-30 | The accounting is per user. |
| 2026-09-30 | Record tokens only, not money: the hub cannot know the real price (per-subaccount AI Core rates, provider discounts). |
| 2026-09-30 | The user is the BTP user from the XSUAA token; a `client_credentials` caller is recorded by its client id. |
| 2026-09-30 | The store is configurable, like the other providers: from SQLite locally to SAP HANA on BTP (CAP `cds.requires.db`). |

## Proposed record (not yet approved)

One record per LLM or embedding call: time, user, provider, model, kind
(`chat` / `embedding`), prompt and completion tokens, channel
(`execute_step`, `/v1/chat/completions`, `/v1/messages`), destination.

## Open question

Who sees the report?

1. Each user sees their own usage; an admin role sees everyone (proposed).
2. Only an admin role.
3. Everyone with access to the hub.
