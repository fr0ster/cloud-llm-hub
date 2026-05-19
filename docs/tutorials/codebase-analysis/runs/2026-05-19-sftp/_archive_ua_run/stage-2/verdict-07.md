# ZSFTP_PATIENTCO_PULL

Tools: SearchObject, ReadProgram, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]
**Verdict:** yes  
**Тип:** PROG (report) — `PROG/P`  
**SFTP-методи / механізми:**
- `SXPG_COMMAND_EXECUTE` (OS-shell через SM69), SM69-команда: `ZSFTP_PATCO_PULL` (параметр `p_comm`)

**Докази (file:line — snippet):**
- `ZSFTP_PATIENTCO_PULL:~` — підтвердження типу/існування (repo):
  - SearchObject: `ZSFTP_PATIENTCO_PULL  PROG/P  ...  package Z001`
- `ZSFTP_PATIENTCO_PULL:...` — збір SFTP-параметрів у командний рядок (user/pass/host + шлях/маска + host key):
  - `READ TABLE ... WITH KEY fnam = 'FTP_USER'. ... g_path = wa_constants-fval.`
  - `READ TABLE ... WITH KEY fnam = 'FTP_PSWD'. ... CONCATENATE g_path ':' wa_constants-fval INTO g_path.`
  - `READ TABLE ... WITH KEY fnam = 'FTP_DOMAIN'. ... CONCATENATE g_path '@' wa_constants-fval INTO g_path.`
  - `READ TABLE ... WITH KEY fnam = 'FOLDER_PATH'. ... CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.`
  - `READ TABLE ... WITH KEY fnam = 'FILE_EXT'. ... CONCATENATE g_path wa_constants-fval INTO g_path ...`
  - `READ TABLE ... WITH KEY fnam = 'HOST_KEY'. ... CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY space.`
- `ZSFTP_PATIENTCO_PULL:...` — фактичний запуск зовнішньої команди (SM69):
  - `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'`
  - `EXPORTING commandname = p_comm additional_parameters = g_path`

**Замітки:**
- Напрямок: **pull** (також підтверджено назвою та описом програми в metadata: *“Patientco Pull SFTP”*, але ключове — що викликається SM69-команда з параметрами для “витягування” файлів).
- Endpoint/host hints: береться з константи `FTP_DOMAIN` (склеюється як `user:password@domain`), також додається `HOST_KEY`.
- Що читається/пишеться: програма **не робить SFTP напряму в ABAP**, а лише формує параметри та викликає зовнішню команду `ZSFTP_PATCO_PULL`. Які саме файли тягне — задається `FOLDER_PATH`, `FILE_EXT` і опційно `p_date` (формується маска `*<date>`).

Додатково (патерн у пакеті): `SearchSource` по пакету `Z001` показує, що це типовий підхід для кількох `ZSFTP_*` програм — вони теж викликають `SXPG_COMMAND_EXECUTE` (в т.ч. `ZSFTP_PATIENTCO_PULL`).
