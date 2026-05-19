# ZSFTP_CAPARIO_PULL

Tools: SearchObject, ReadProgram, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]
**Verdict:** yes

**Тип:** PROG (executable program) — `ZSFTP_CAPARIO_PULL` (package `Z001`)

**SFTP-методи / механізми:**
- `SXPG_COMMAND_EXECUTE` (legacy OS-shell через SM69), SM69-команда: `ZFTP_EOB_PULL` (параметр `p_comm`)

**Докази (ZSFTP_CAPARIO_PULL:line — snippet):**
- `ZSFTP_CAPARIO_PULL:25` — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_EOB_PULL' .`
- `ZSFTP_CAPARIO_PULL:161` — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'`
- `ZSFTP_CAPARIO_PULL:29-33` — `SELECT * FROM zfi_constants ... WHERE pname = 'ZSFTP_835_PULL'.` (підтягує SFTP/FTP параметри з кастомної таблиці)
- `ZSFTP_CAPARIO_PULL:35-44` — читає `FTP_USER` і додає в `g_path`
- `ZSFTP_CAPARIO_PULL:52-61` — читає `FTP_PSWD` і робить `CONCATENATE g_path ':' wa_constants-fval INTO g_path.`
- `ZSFTP_CAPARIO_PULL:62-80` — читає `FTP_DOMAIN` і робить `CONCATENATE g_path '@' wa_constants-fval INTO g_path.`
- `ZSFTP_CAPARIO_PULL:93-106` — читає `FOLDER_PATH` і додає в `g_path`
- `ZSFTP_CAPARIO_PULL:107-131` — читає `FILE_EXT`, опційно додає `*<date>` і розширення/маску в `g_path`
- `ZSFTP_CAPARIO_PULL:132-145` — читає `HOST_KEY` і додає в `g_path`
- `ZSFTP_CAPARIO_PULL:156-166` — `commandname = p_comm` + `additional_parameters = g_path`

**Замітки:**
- Напрямок: **pull** (і по назві, і по дефолтній SM69-команді `ZFTP_EOB_PULL`, і по тому що формується remote-spec + folder/file mask для команди).
- Endpoint/host hints: береться з `zfi_constants` як `FTP_DOMAIN` (фактично host/domain) + `HOST_KEY` (ознака SSH/SFTP host key).
- Що читається/пишеться: програма **збирає** рядок параметрів `g_path` у форматі схожому на `user:password@domain <folder> <filemask> <host_key>` і передає його в OS-команду через `SXPG_COMMAND_EXECUTE` (реальна SFTP-логіка в SM69 команді `ZFTP_EOB_PULL`, не в ABAP-коді).

Додатково (підтвердження патерну в пакеті):
- `SearchSource` по `Z001` показує, що `SXPG_COMMAND_EXECUTE` використовується і в інших `ZSFTP_*` програмах, включно з `ZSFTP_CAPARIO_PULL` (hit на `line 161`).
