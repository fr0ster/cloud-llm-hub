# ZSFTP_BNP_PARIBAS_PULL

Tools: SearchObject, ReadProgram, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]
**Verdict:** yes  
**Тип:** PROG (executable program) — `ZSFTP_BNP_PARIBAS_PULL` (package `Z001`)

**SFTP-методи / механізми:**
- `SXPG_COMMAND_EXECUTE` → legacy OS-shell SFTP через **SM69 command** `ZFTP_BNPP_PULL` (параметр `p_comm`)

**Докази (file:line — snippet):**
- `ZSFTP_BNP_PARIBAS_PULL:18` — `REPORT zsftp_bnp_paribas_pull.`
- `ZSFTP_BNP_PARIBAS_PULL:31` — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_BNPP_PULL' .`
- `ZSFTP_BNP_PARIBAS_PULL:44-121` — збірка параметрів в один рядок для OS-команди (в т.ч. SFTP-атрибути):
  - `READ TABLE ... WITH KEY fnam = 'FTP_USER'.` → `g_path = wa_constants-fval.`
  - `READ TABLE ... WITH KEY fnam = 'FTP_PSWD'.` → `CONCATENATE g_path ':' wa_constants-fval INTO g_path.`
  - `READ TABLE ... WITH KEY fnam = 'FTP_DOMAIN'.` → `CONCATENATE g_path '@' wa_constants-fval INTO g_path.`
  - `READ TABLE ... WITH KEY fnam = 'FTP_PORT'.` → `CONCATENATE g_path ':' wa_constants-fval INTO g_path.`
  - `READ TABLE ... WITH KEY fnam = 'FOLDER_PATH'.` → `CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.`
  - `READ TABLE ... WITH KEY fnam = 'FILE_EXT'.` → `CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.`
  - `READ TABLE ... WITH KEY fnam = 'HOST_KEY'.` → `CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.`
- `ZSFTP_BNP_PARIBAS_PULL:143-148` — фактичний запуск SM69-команди:
  - `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'`
  - `commandname = p_comm`
  - `additional_parameters = g_path`

**Замітки:**
- Напрямок: **pull** (з назви та опису програми: *“SFTP BNP PARIBAS Ack, MT940 pull”* у metadata), технічно підтверджено тим, що викликається SM69-команда `ZFTP_BNPP_PULL`, але що саме вона робить (get/put) — у цьому ABAP-сорсі не видно.
- Endpoint/host hints: `FTP_DOMAIN` (+ опційно `FTP_PORT`), user/pass (`FTP_USER`/`FTP_PSWD`), `HOST_KEY`, а також шлях/фільтр файлів (`FOLDER_PATH`, `FILE_EXT`) передаються як `additional_parameters` в OS-команду.
- Це відповідає правилу **yes**: є `SXPG_COMMAND_EXECUTE` і асемблюються `FTP_USER`/`HOST_KEY` (а також інші SFTP-параметри).
