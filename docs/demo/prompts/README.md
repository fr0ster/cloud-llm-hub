# Demo Prompts

Ready-to-paste prompts for the Cloud LLM Hub chat UI. Prompts are grouped by intent:

| Folder | Audience | Shows |
|--------|----------|-------|
| [discovery/](discovery/) | Everyone | Navigating unfamiliar SAP systems, finding objects |
| [analysis/](analysis/) | Developers, support | Understanding code, diagnosing runtime issues |
| [security/](security/) | Security, auditors | Static checks for common ABAP vulnerabilities |
| [development/](development/) | Developers | Generating skeletons (CDS, class, RAP BO) |

## Prompt File Format

Each prompt file follows this layout:

```markdown
# <Short Title>

**Goal:** one line on what this demonstrates.
**Destination:** expected BTP destination (e.g., `S4HANA_DEV`).
**Expected tools invoked:** GetPackageStructure, GetProgram, ...

## Prompt
<the actual text to paste>

## Expected Outcome
<what the demo audience should see>

## Troubleshooting
<common failures and mitigations>
```

## Tips for Live Demos

- Pre-warm the session: ask one "hello" question first so model/embedding cold-start doesn't distort timings.
- Watch the tool-trace panel (`[SmartAgent: Executing ...]`) — it's the strongest signal that the agent really talked to SAP.
- If a prompt returns generic text with low token count, the tool likely wasn't executed — retry in a fresh session.
