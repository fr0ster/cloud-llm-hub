# ZEDI_835

Tools: SearchObject, ReadProgram, SearchSource, SearchSource, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** **unclear** (у доступному сорсі `ZEDI_835` немає жодних прямих викликів/згадок SFTP/FTP/SM69; логіка може бути в includes, але їхній код тут не прочитано)

**Тип:** **PROG** (executable program)

**SFTP-методи / механізми:**
- **не виявлено** (нема `SXPG_COMMAND_EXECUTE`, нема згадок `SFTP`/`FTP`, нема очевидних класів/ФМ для SFTP у просканених ZEDI* об’єктах пакета)

**Докази (file:line — snippet):**
- `ZEDI_835:1-5` — заголовок репорту підтверджує, що це report:
  ```abap
  *& Report  ZEDI_835
  ```
- `ZEDI_835:7-8` — основна логіка винесена в includes (потенційно там може бути інтеграція з файлами/мережею, але без їх коду це не доводить SFTP):
  ```abap
  INCLUDE zedi_edi_top.
  INCLUDE zedi_835_top.
  ```
- `ZEDI_835:12-14` — читає “selected file” через FORM, але без деталей транспорту:
  ```abap
  START-OF-SELECTION.
    PERFORM read_file_data.
  ```
- `ZEDI_835:...` — ще один include з формами:
  ```abap
  INCLUDE zedi_835_f01.
  ```

**SearchSource (пакет Z001, об’єкти ZEDI*):**
- `SXPG_COMMAND_EXECUTE`: **0 hits**
- `SFTP`: **0 hits**
- `FTP`: **0 hits**

**Замітки:**
- Напрямок (push/pull), endpoint/host, key/credential hints — **не визначається** з наявного сорсу головної програми.
- Щоб зробити **yes/no** з доказами, треба прочитати includes `ZEDI_EDI_TOP`, `ZEDI_835_TOP`, `ZEDI_835_F01` (саме там, імовірно, реалізовано file I/O / інтеграцію). Якщо скажеш їхні типи/де знайти (PROG include / function group include), я продовжу аналіз.
