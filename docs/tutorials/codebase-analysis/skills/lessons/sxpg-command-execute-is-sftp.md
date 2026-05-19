---
name: sxpg-command-execute-is-sftp
description: SXPG_COMMAND_EXECUTE with FTP_*/SSH_* credential parameters is a SFTP verdict, not unclear
trigger: Stage 2 / Stage 4 — encountering CALL FUNCTION 'SXPG_COMMAND_EXECUTE' in a candidate object
---

# Lesson — `SXPG_COMMAND_EXECUTE` is SFTP-over-OS

## Trigger

You're verdicting whether an ABAP object uses SFTP. Source contains:

```abap
CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
  EXPORTING commandname = ... additional_parameters = ...
```

and the parameters that get assembled include any of: `FTP_USER`, `FTP_DOMAIN`, `FTP_HOST`, `HOST_KEY`, `PRIVATE_KEY_PATH`, `PASSPHRASE`, `SSH_*`.

## Why a default LLM gets this wrong

`SXPG_COMMAND_EXECUTE` is a generic "run any external OS command configured in SM69" wrapper. It is **not** an SFTP API in itself. A surface-only reading says: "no native SFTP call here → unclear."

But that's the wrong frame. The SM69 command name is a binding to an OS-side `sftp` / `scp` / `lftp` binary, and the credential parameters are the SFTP secret bundle. The mechanism is real SFTP, just delegated to the OS.

## Verdict rule

| Source shape | Verdict |
|---|---|
| `SXPG_COMMAND_EXECUTE` + ≥1 SFTP-credential parameter assembled into `additional_parameters` | **yes** (legacy OS-shell SFTP via SM69) |
| `SXPG_COMMAND_EXECUTE` + no credential parameters, no shape hint | **unclear** — fetch SM69 entry if possible, else flag for Stage 4 |
| `SXPG_COMMAND_EXECUTE` calling a clearly non-SFTP command (`UNZIP`, `DATE`, …) | **no** |

## How to apply in Stage 2 prompt

Include in the system / user prompt:

> SXPG_COMMAND_EXECUTE is a generic shell-call wrapper. If the source assembles FTP_*, SSH_*, HOST_KEY, PRIVATE_KEY_PATH, or PASSPHRASE parameters into the call, treat it as a confirmed SFTP usage and record the SM69 command name as the "method".

## Why this matters for the migration handoff

Stage 5 must enumerate every SFTP mechanism a future replacement has to cover. Missing the OS-shell channel (because the model said "unclear") means a whole class of usage sites gets dropped silently — exactly the failure mode the tutorial's "evidence-backed verdict" rule exists to prevent.

## Worked example

`ZDEMO_FT_CITI_PULL` (2026-05-19 run, seed #14): `SXPG_COMMAND_EXECUTE` with SM69 command `ZDEMO_FT_CITI_PULL` and parameters `FTP_USER`, `FTP_DOMAIN`, `HOST_KEY`, `PRIVATE_KEY_PATH`, `PASSPHRASE` from `zfi_constants`. Initial model verdict: unclear. Corrected verdict: yes.
