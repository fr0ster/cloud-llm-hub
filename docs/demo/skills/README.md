# Demo Skills

Reusable instructions that encode how the agent should operate on SAP systems for recurring tasks.

| Skill | Purpose |
|-------|---------|
| [abap-code-review.md](abap-code-review.md) | Structured code review checklist (clean ABAP, performance, maintainability). |
| [dump-analysis.md](dump-analysis.md) | Step-by-step root-cause analysis for ST22 short dumps. |
| [rap-bo-creation.md](../../tutorials/skills/rap-bo-creation.md) | Already shipped with tutorials — constraints for creating RAP managed BOs. |

## Format

Each skill uses the same frontmatter as existing tutorial skills:

```yaml
---
name: <short name>
description: <one line — when to apply>
version: <semver>
tags: [sap, abap, ...]
---
```

## How Skills Are Consumed

Skills are plain Markdown and can be:
1. Injected into the system prompt via `LLM_AGENT_SKILLS` (comma-separated paths).
2. Referenced from a user prompt: "Follow the dump-analysis skill and analyze ...".
3. Loaded into RAG alongside other documents (weaker signal, but works for ad-hoc sessions).
