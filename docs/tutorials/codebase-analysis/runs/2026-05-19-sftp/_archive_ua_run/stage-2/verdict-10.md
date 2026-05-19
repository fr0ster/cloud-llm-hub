# ZEDI_835_JPM

Tools: SearchObject, ReadProgram, GetProgFullCode, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetProgFullCode...]


[SmartAgent: Executing SearchSource...]
**Verdict:** no  
**Тип:** PROG (executable report) `ZEDI_835_JPM` (package `Z001`)

**SFTP-методи / механізми:**  
- Не знайдено. У коді немає викликів `SXPG_COMMAND_EXECUTE`, `FTP*`, `SSH*`, `SFTP`, `CL_SFTP*`, `CL_FTP*` тощо. Є лише робота з файловою системою аплікейшн-сервера та фронтенда.

**Докази (file:line — snippet):**
- `ZEDI_835_JPM_F01:~45-60` — читання списку файлів з директорії на аплікейшн-сервері (не SFTP):
  - `CALL FUNCTION 'EPS2_GET_DIRECTORY_LISTING' ... iv_dir_name = lv_file_name`
- `ZEDI_835_JPM_F01:~78-92` — читання файлу з аплікейшн-сервера:
  - `OPEN DATASET gv_file FOR INPUT ...`
  - `READ DATASET gv_file INTO wa_final_data.`
- `ZEDI_835_JPM_F01:~150-170` — завантаження файлу з ПК (GUI), не SFTP:
  - `CALL FUNCTION 'GUI_UPLOAD' EXPORTING filename = p_file ...`
- `ZEDI_835_JPM_F01:~520-545` — переміщення файлів через OS команду `MOVE` (локальна ОС, не SM69/SXPG):
  - `CONCATENATE 'MOVE' gv_file gv_arc_file INTO lv_parcom SEPARATED BY space.`
  - `CALL 'SYSTEM' ID 'COMMAND' FIELD lv_parcom ...`
- `ZEDI_835_JPM_F01:~555-580` — аналогічно для error-folder:
  - `CONCATENATE 'MOVE' gv_file gv_err_file INTO lv_parcom ...`
  - `CALL 'SYSTEM' ...`

**Замітки:**
- Напрямок: **pull/ingest** з директорії аплікейшн-сервера (та альтернативно manual upload з фронтенда), далі архівація/переміщення в `...\\data\\FTP\\JPMorgan\\Inbound\\Lockbox\\...` (це лише шлях/неймінг “FTP”, не доказ SFTP).
- Endpoint/host/user/key hints: **відсутні** в сорсі (нема host/user/key/passphrase/known_hosts тощо).
- SM69/SXPG: **не використовується** (немає `SXPG_COMMAND_EXECUTE`; є прямий `CALL 'SYSTEM'` з `MOVE`).
