---
name: consumer-discovery-by-source
description: 'To enumerate consumers of a mechanism (SFTP, IDoc, RFC, …) in an unfamiliar customer codebase, never rely on object-name patterns ("scan for _SFTP-shaped names"). Use three source-driven channels: (1) SearchSource on the call-site literal that proves the mechanism (e.g. "SXPG_COMMAND_EXECUTE"); (2) SearchSource on the credential or destination literal that has to be read before the mechanism call (e.g. "PRIVATE_KEY_PATH", a known SM69 command prefix); (3) GetWhereUsed on every wrapper artifact surfaced by (1)+(2). Claim completeness only when at least two of these three channels converge to the same set.'
---
