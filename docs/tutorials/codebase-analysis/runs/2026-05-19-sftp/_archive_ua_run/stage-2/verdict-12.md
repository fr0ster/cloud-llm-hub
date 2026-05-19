# ZSD_MEDICARE_PDF_PROCESS

Tools: SearchObject, ReadProgram, SearchSource, SearchObject, ReadProgram, ReadProgram



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing ReadProgram...]
**Verdict:** unclear  
**Тип:** PROG (executable report) — `ZSD_MEDICARE_PDF_PROCESS` (package `Z001`)

**SFTP-методи / механізми:**  
- Немає підтверджених зі сорсу викликів SFTP (ні `SXPG_COMMAND_EXECUTE`, ні FTP/SSH lib/FMs, ні класів-конекторів). Є лише PERFORM-и з назвами “*_sftp”, але їх реалізацію в цьому доступному читанні не видно.

**Докази (file:line — snippet):**
- `ZSD_MEDICARE_PDF_PROCESS:30` — `PERFORM f_get_files_from_sftp.`  
- `ZSD_MEDICARE_PDF_PROCESS:42` — `PERFORM f_send_error_file_to_sftp.`

**Замітки:**
- Напрямок за назвами форм виглядає як **pull** (“get files from sftp”) + **push** (“send error file to sftp”), але це лише inference з імен, **без доказу реалізації**.
- Репорт включає інклюди:
  - `INCLUDE zsd_medicare_pdf_process_top.`
  - `INCLUDE zsd_medicare_pdf_process_f01.`
  Однак прочитати їхній код через доступні інструменти не вдалось: `ReadProgram` для `ZSD_MEDICARE_PDF_PROCESS_TOP` та `..._F01` повертає `source_code = null`, тому підтвердити реальний SFTP-механізм (SM69/SXPG, ключі, хости, команди) неможливо.

Якщо надаси код інклюдів (TOP/F01) або я зможу їх прочитати іншим способом, тоді зможу дати **yes/no** з конкретними FM/класами/SM69-командами та рядками.
