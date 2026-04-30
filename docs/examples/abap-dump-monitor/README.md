# abap-dump-monitor

Standalone CAP example service that:

1. Periodically polls FIDS (ABAP runtime errors) via cloud-llm-hub MCP (`RuntimeListFeeds(feed_type='dumps')`).
2. Persists each new dump to HANA Cloud with a structured composition tree (call stack, referenced objects, variables, source extract).
3. Asks cloud-llm-hub `/v1/chat/completions` to analyze the dump and stores the LLM response.
4. Creates a Jira ticket on success — or comments on an existing open ticket when the same signature recurs.

All operational policy (polling interval, due-date thresholds, Jira project, etc.) is **hot-reloadable** via OData `PATCH` against the `Setting` entity — no redeploy.

See:
- [docs/OVERVIEW.md](docs/OVERVIEW.md) — architecture
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — BTP / Jira / cloud-llm-hub setup
- [docs/CONSUMER-GUIDE.md](docs/CONSUMER-GUIDE.md) — how to operate the service

> Local `cds watch` is NOT supported because the service depends on BTP destinations + cloud-llm-hub MCP at runtime. Validate via deploy to a dev subaccount.
