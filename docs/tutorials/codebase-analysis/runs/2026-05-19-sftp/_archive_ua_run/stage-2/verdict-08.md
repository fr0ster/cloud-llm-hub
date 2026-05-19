# ZSFTP_CAPARIO

Tools: SearchObject, ReadProgram, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]
**Verdict:** yes  
**Тип:** PROG (executable program) — `ZSFTP_CAPARIO` (package `Z001`)

**SFTP-методи / механізми:**
- `SXPG_COMMAND_EXECUTE` (OS-shell команда через SM69), `commandname = p_comm` (default `ZFTP_837`) + `additional_parameters = g_path` (в ньому збираються SFTP/FTP параметри)

**Докази (file:line — snippet):**
- `ZSFTP_CAPARIO:13` — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_837' .`
- `ZSFTP_CAPARIO:153-158` — виклик SM69-команди:
  - `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'`
  - `commandname = p_comm`
  - `additional_parameters = g_path`
- `ZSFTP_CAPARIO:20-125` — асемблиться параметр-рядок `g_path` з **FTP_USER** та **HOST_KEY** (і іншими), що за вашим правилом = **yes**:
  - `READ TABLE ... WITH KEY fnam = 'FTP_USER'.` → `g_path = wa_constants-fval.`
  - `READ TABLE ... WITH KEY fnam = 'FTP_PSWD'.` → `CONCATENATE g_path ':' wa_constants-fval INTO g_path.`
  - `READ TABLE ... WITH KEY fnam = 'FTP_DOMAIN'.` → `CONCATENATE g_path '@' wa_constants-fval INTO g_path.`
  - `READ TABLE ... WITH KEY fnam = 'HOST_KEY'.` → `CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.`

**Замітки:**
- Напрямок/операція (push чи pull) з коду **не видно**: ABAP лише збирає креденшали/параметри та викликає зовнішню команду `ZFTP_837` через `SXPG_COMMAND_EXECUTE`. Реальна SFTP-логіка/тип операції закладена в SM69-команді `ZFTP_837` (її текст/скрипт тут не видно).
- Endpoint/host hints: формується як `user:password@domain` + далі додаються `FOLDER_PATH`, `FILE_EXT`, `HOST_KEY`, `DESTINATION_FOLDER` (усе з `zfi_constants` для `pname = 'EDI837_OUTBOUND'`).
