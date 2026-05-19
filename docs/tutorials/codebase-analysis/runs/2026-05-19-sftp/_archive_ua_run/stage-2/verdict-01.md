# /VERTEX/SPOT_VAT_OUTPUT_COMPL

Tools: SearchObject, ReadProgram, SearchSource, SearchSource, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** no

**Тип:** PROG (executable program)  
- `/VERTEX/SPOT_VAT_OUTPUT_COMPL` існує як `PROG/P` (і окремо як enhancement spot `ENHS/XS`).  
  **Доказ:** SearchObject → `/VERTEX/SPOT_VAT_OUTPUT_COMPL  PROG/P  Program ...  package /VERTEX/SPOT`

**SFTP-методи / механізми:**  
- Немає знайдених (ні FM/класи для SFTP, ні `SXPG_COMMAND_EXECUTE`, ні FTP/SFTP ключові слова, ні SM69-виклики) в пакеті `/VERTEX/SPOT`.

**Докази (file:line — snippet):**
- `/VERTEX/SPOT_VAT_OUTPUT_COMPL` (report) виконує лише формування/вивід ALV та створення файлу через helper-клас `/vertex/cl_spot`:
  - `CALL METHOD /vertex/cl_spot=>create_file_new ... iv_gui_download = p_pc ... iv_filename = lv_filename ...`  
  - `CALL METHOD /vertex/cl_spot=>validate_file_name ...`
  - `CALL METHOD /vertex/cl_spot=>browse_and_set ...`
  (У прочитаному сорсі відсутні будь-які виклики SFTP/SSH/SM69/`SXPG_COMMAND_EXECUTE`.)

- SearchSource по пакету `/VERTEX/SPOT`:
  - `query = "SFTP"` → **0 hits**
  - `query = "SXPG_COMMAND_EXECUTE"` → **0 hits**
  - `query = "FTP"` → **0 hits**

**Замітки:**
- Напрямок роботи з файлами тут виглядає як **локальний PC download або запис на application server** (перемикачі `p_pc`, `p_server`) через `/vertex/cl_spot=>create_file_new`, але **це не SFTP** і в даному об’єкті/пакеті немає доказів, що далі файл кудись відправляється по SFTP.
- Якщо SFTP реалізовано всередині `/vertex/cl_spot` або в іншому пакеті — потрібен окремий аналіз того класу/пакету (в межах цього запиту доказів немає).
