# ZDMS_UPLOAD_FILES

Tools: SearchObject, ReadProgram, GetObjectInfo, SearchSource, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetObjectInfo...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** unclear  
**Тип:** PROG (executable program) `ZDMS_UPLOAD_FILES` (type `PROG/P`, package `Z001`)

**SFTP-методи / механізми (реальні виклики):**
- **Не знайдено** в доступному сорсі жодного явного SFTP-механізму (ні `SXPG_COMMAND_EXECUTE`, ні класів/ФМ для SSH/SFTP). Є лише PERFORM-и з назвами, що натякають на SFTP, але їх імплементація в includes не прочитана (в цьому інтерфейсі не видно include-коду).

**Докази (file:line — snippet):**
- `ZDMS_UPLOAD_FILES:43` — `PERFORM f_get_files_from_sftp.`  
- `ZDMS_UPLOAD_FILES:57` — `PERFORM f_send_error_file_to_sftp.`  
- (контекст) `ZDMS_UPLOAD_FILES:42` — `*Get files from SFTP`  
- (контекст) `ZDMS_UPLOAD_FILES:56` — `*Put files into SFTP`

**Перевірка legacy OS-shell SFTP через SM69 (правило про SXPG):**
- Пошук `SXPG_COMMAND_EXECUTE` у `ZDMS_UPLOAD_FILES*` у пакеті `Z001` → **нічого не знайдено** (тобто доказів SM69/SXPG тут немає).

**Замітки:**
- Напрямок за назвами PERFORM-ів: виглядає як **pull** (`f_get_files_from_sftp`) + **push** (`f_send_error_file_to_sftp`), але це **лише назви**, без доказів механізму/endpoint.
- Щоб перейти з **unclear → yes/no**, треба прочитати includes `ZDMS_UPLOAD_FILES_TOP` і `ZDMS_UPLOAD_FILES_F01` (там має бути реальна імплементація SFTP: `SXPG_COMMAND_EXECUTE`, `CL_SSH*`, сторонні FM, або виклики HTTP/REST до SFTP-gateway тощо). У наданому читанні програми include-код не розкритий.
