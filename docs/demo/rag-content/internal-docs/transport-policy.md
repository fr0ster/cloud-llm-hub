---
type: standard
tags: [transport, release, governance]
system: all
---

# MOCK Corp — Transport & Release Policy

## Landscape

| System | Client | Role |
|--------|--------|------|
| MOCK-DEV | 100 | Development |
| MOCK-QAS | 200 | QA / integration |
| MOCK-PRD | 300 | Production |

All transports flow DEV → QAS → PRD. No cross-client imports.

## Transport Requests

- TR description: `[<JIRA-ID>] <short summary>` (e.g., `[MOCK-4521] Fix pricing rounding`).
- One TR per JIRA ticket. Splitting across TRs allowed only with release manager approval.
- Changing objects owned by another team requires that team's approval in the JIRA ticket.

## Approval Gates

| Stage | Gate |
|-------|------|
| DEV → QAS | Peer code review (2 reviewers), unit tests green, ATC priority 1-2 clean. |
| QAS → PRD | QA sign-off, UAT sign-off, release manager approval, change advisory board (CAB) for high-risk changes. |

## Release Windows

- Regular releases: every Tuesday 18:00 CET.
- Hotfixes: any time, release manager approval required.
- Freeze windows: last week of each fiscal quarter. Only P1 incident fixes allowed.

## ATC Policy

Priority 1 and 2 findings block transport release. Priority 3 finding requires a JIRA ticket tracking remediation.

Exemptions must be documented in the transport's description and approved by the release manager.

## Rollback

Every PRD-bound TR must have a documented rollback plan in JIRA:
- Whether the change is reversible by importing a prior TR.
- Manual data correction steps, if any.
- Estimated rollback duration.

## See Also
- [internal-docs/naming-conventions.md](naming-conventions.md)
