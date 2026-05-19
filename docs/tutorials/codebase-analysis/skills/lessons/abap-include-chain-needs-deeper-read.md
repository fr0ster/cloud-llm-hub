---
name: abap-include-chain-needs-deeper-read
description: Stage 2 stalls on ABAP programs whose logic lives in INCLUDE files — give the agent GetIncludesList up-front
trigger: Stage 2 — seed is a PROG with main program containing only `INCLUDE …_TOP`, `INCLUDE …_F01`, no inline logic
---

# Lesson — ABAP include chain breaks shallow reads

## Trigger

Stage-2 response ends without an explicit `**Verdict:**` line, and the trailing reasoning says something like:

> "щоб дати yes/no потрібно прочитати includes ZFOO_TOP, ZFOO_F01" / "logic likely lives in include … not visible here".

This means `ReadProgram` returned only the main-program shell (PARAMETERS + a few INCLUDE lines + main FORMs that immediately PERFORM into another include). The model lacked a tool action to expand the include tree.

## Why a default Stage-2 prompt misses this

The default Stage-2 prompt tells the agent to use `SearchObject` → `ReadProgram` → `SearchSource`. Includes don't show up in `SearchObject` results because they aren't separate tadir entries in the usual sense; they're sub-objects of the main program. So the agent reads the main program, sees almost nothing, and either (a) gives up with implicit unclear or (b) hallucinates a verdict.

## How to apply in Stage 2 prompt

Add to the standard prompt:

> If `ReadProgram` returns a source that is mostly `INCLUDE …` statements with little or no inline logic, immediately call `GetIncludesList` for that program and then `ReadProgram` (or `GetInclude`, if available) on each include in turn. Treat the union of the main program and its includes as the source-of-truth.

## What to do for the current run

For seeds where Stage-2 stalled on this pattern:

1. Record the seed as **unclear (include chain)** in `02-methods.md` with a note.
2. Re-queue for a follow-up call in Stage 3 with `GetIncludesList` explicitly requested.
3. Do not block the rest of the batch on these.

## Worked examples (2026-05-19 run)

- `ZDEMO_EDI`: main program references `ZDEMO_EDI_TOP`, `ZDEMO_EDI_TOP`, `ZDEMO_EDI_F01` — verdict stuck without these.
- `ZDEMO_BANK_STMT_LOAD`: main shell PERFORMs `f_upload_ebs` defined in `ZDEMO_BANK_STMT_LOAD_F01` — verdict stuck without the include.
