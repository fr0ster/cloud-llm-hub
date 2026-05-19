# ZSFTP_CITI_PULL

Tools: SearchObject, ReadProgram, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]
**Verdict:** yes  
**Тип:** PROG (executable program) — `ZSFTP_CITI_PULL`

**SFTP-методи / механізми:**
- `SXPG_COMMAND_EXECUTE` (legacy OS-shell виклик через SM69), SM69-команда: `ZSFTP_CITI_PULL` (параметр `p_comm`)

**Докази (file:line — snippet):**
- `ZSFTP_CITI_PULL:16` — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZSFTP_CITI_PULL'.`
- `ZSFTP_CITI_PULL:45-49` — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' ... commandname = p_comm  additional_parameters = g_path`
- `ZSFTP_CITI_PULL:24-30` — асемблюються параметри, характерні для SFTP/SSH:
  - `PERFORM f_set_parameter USING 'PASSPHRASE' ...`
  - `PERFORM f_set_parameter USING 'FTP_USER' ...`
  - `PERFORM f_set_parameter USING 'HOST_KEY' ...`
  - `PERFORM f_set_parameter USING 'PRIVATE_KEY_PATH' ...`
- `ZSFTP_CITI_PULL:86-93` — збірка `additional_parameters` в один рядок:
  - `CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY p_sep.`

**Замітки:**
- Напрямок: **pull** (з опису програми) — `description="Pull MT940 into AL11 from citi"` (метадані ReadProgram).
- Endpoint/host hints: у коді напряму не видно host/URL; параметри беруться з таблиці `ZFI_CONSTANTS` для `pname = 'ZSFTP_CITI'` (`ZSFTP_CITI_PULL:19-21`), тобто host/endpoint, ймовірно, заховані в кастомайзінгу.
- Що читається/пишеться: фактичний transfer робиться зовнішньою OS-командою (SM69) з параметрами `g_path`; сам ABAP лише формує параметри й виводить `exec_protocol` (`ZSFTP_CITI_PULL:45-74`).
