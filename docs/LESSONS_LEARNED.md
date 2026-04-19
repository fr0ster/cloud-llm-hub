# Lessons Learned

Catalog of non-obvious mistakes hit during development and deployment. Each lesson lives in its own file under `docs/lessons/`, named `YYYY-MM-DD-<short-slug>.md`. Entries are append-only — to correct or extend an existing lesson, edit it in place; do not rewrite history.

Each lesson file has a YAML frontmatter block (`date`, `branch`, `subaccount`, `space`, `tags`) and a body covering: what went wrong · why · fix · prevention rule. Rich-enough to support later expansion into a public article.

## Catalog

| Date | Lesson | Branch | Subaccount |
|------|--------|--------|------------|
| 2026-04-19 | [XSUAA `grant-as-authority-to-apps` syntax rules](lessons/2026-04-19-xsuaa-cross-app-grants.md) | `feat/consumer-xsuaa-instances` | epam-sap-mcp-450kjhsb |
| 2026-04-19 | [XSUAA binding-secret tied to service key](lessons/2026-04-19-xsuaa-binding-secret-lifecycle.md) | `feat/consumer-xsuaa-instances` | epam-sap-mcp (consumer) + ai-applications (source) |
| 2026-04-19 | [`cf deploy --abort-on-error` leaves failed services](lessons/2026-04-19-cf-deploy-rollback.md) | `feat/consumer-xsuaa-instances` | epam-sap-mcp-450kjhsb |
| 2026-04-19 | [`git add -A` swept in unrelated dirty files](lessons/2026-04-19-git-add-discipline.md) | `feat/consumer-xsuaa-instances` | n/a |
| 2026-04-19 | [Shell expansion corrupts xsuaa secrets with `$`](lessons/2026-04-19-shell-expansion-secrets.md) | `feat/consumer-xsuaa-instances` | epam-sap-mcp-450kjhsb |

## Adding a new lesson

1. Create `docs/lessons/YYYY-MM-DD-<slug>.md` with the frontmatter + body sections.
2. Add a row to the catalog above (chronological, newest at bottom).
3. Include the fix commit in the same PR where you introduce the lesson — if the lesson describes failures on that PR itself, add the lesson in a follow-up commit on the same branch.

## Tags

`xsuaa`, `btp`, `cf`, `mta`, `deploy`, `aicore`, `cross-subaccount`, `credentials`, `git`, `workflow`, `shell`, `secrets`
