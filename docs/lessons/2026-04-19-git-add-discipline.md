---
date: 2026-04-19
branch: feat/consumer-xsuaa-instances
subaccount: n/a
space: n/a
tags: [git, workflow]
---

# `git add -A` in a feat branch swept in unrelated dirty files

## What went wrong

Used `git add -A` for a focused xsuaa syntax fix commit. It picked up an in-progress edit in `app/router/chat/webapp/index.html` (unrelated UI change) and a `package-lock.json` drift. The fix commit reported "5 files changed, 148 insertions" instead of the expected "3 files changed, 6 insertions" for three JSON edits.

## Why

This repo routinely has multiple unrelated in-progress edits in sibling files (UI, docs, runtime configs), plus `package-lock.json` can drift between npm runs. `git add -A` has no way to distinguish "belongs to this commit" from "happened to be dirty in the worktree".

## Fix

```bash
git reset --soft HEAD~1            # keep changes staged
git restore --staged <unrelated>   # unstage noise
git commit -m "..."                # recommit clean
```

## Prevention rule

- Stage files by explicit path (`git add xs-security.json xs-security-analyst-consumer.json ...`). Never `git add -A` or `git add .` for feat commits.
- Before committing, run `git status --short` and stage only the lines that belong to the commit's subject.
- Deploy branches (`deploy/ai-applications`, `deploy/epam-sap-mcp`) carry subaccount-specific dirty state that must never ride along with a feat commit.
