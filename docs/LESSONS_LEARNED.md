# Lessons Learned

Catalog of non-obvious mistakes hit during development and deployment. Each lesson lives in its own file under `docs/lessons/`, named `YYYY-MM-DD-<short-slug>.md`. Entries are append-only — to correct or extend an existing lesson, edit it in place; do not rewrite history.

Each lesson file has a YAML frontmatter block (`date`, `branch`, `subaccount`, `space`, `tags`) and a body covering: what went wrong · why · fix · prevention rule. Rich-enough to support later expansion into a public article.

## Catalog

| Date | Lesson | Branch | Subaccount |
|------|--------|--------|------------|
| | _Catalog reset 2026-04-27 — append new entries below._ Earlier 2026-04-19 entries retired with the docs cleanup; recover from git history if needed. | | |
| 2026-06-04 | [Proxy routing, SAP mandant, CSRF-retry lockout](lessons/2026-06-04-proxy-routing-mandant-lockout.md) | main | ai-applications / nvcr |
| 2026-06-07 | [`${default-url}` points at a dead route once srv has an explicit route](lessons/2026-06-07-default-url-dead-srv-route.md) | main | ai-applications |
| 2026-06-10 | [abap-dump-monitor: the cloud-llm-hub → ABAP → Jira auth chain](lessons/2026-06-10-dump-monitor-auth-chain-and-jira-squid.md) | main | ai-applications |
| 2026-06-11 | [UpdateClass "not locked" — stateless PUT after lock, BASIS-version-dependent](lessons/2026-06-11-update-lock-stateless-put-basis-version.md) | main | nvcr (DS4) |

## Adding a new lesson

1. Create `docs/lessons/YYYY-MM-DD-<slug>.md` with the frontmatter + body sections.
2. Add a row to the catalog above (chronological, newest at bottom).
3. Include the fix commit in the same PR where you introduce the lesson — if the lesson describes failures on that PR itself, add the lesson in a follow-up commit on the same branch.

## Tags

`xsuaa`, `btp`, `cf`, `mta`, `deploy`, `aicore`, `cross-subaccount`, `credentials`, `git`, `workflow`, `shell`, `secrets`
