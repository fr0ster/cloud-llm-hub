---
name: sxpg-sftp-verdict
description: 'Verdict rule for CALL FUNCTION ''SXPG_COMMAND_EXECUTE'' on the SFTP-usage question. With FTP_*/SSH_*/HOST_KEY/PRIVATE_KEY_PATH/PASSPHRASE assembled into additional_parameters → yes (legacy OS-shell SFTP via SM69; record the SM69 command name as the method). With no credential parameters and no shape hint → unclear (fetch the SM69 entry if reachable, else flag for the next stage). Calling a clearly non-SFTP command (UNZIP, DATE, …) → no. SXPG_COMMAND_EXECUTE is a generic OS-shell wrapper — surface absence of a native ABAP SFTP API is not evidence against SFTP.'
---
