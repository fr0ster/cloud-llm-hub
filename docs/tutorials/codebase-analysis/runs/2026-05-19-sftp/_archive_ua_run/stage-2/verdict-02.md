# /VERTEX/SPOT_VAT_INPUT_COMPL

Tools: SearchObject, ReadProgram, HandlerGet, SearchSource, SearchSource



[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing HandlerGet...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
**Verdict:** no  
**Тип:** PROG (report) — `/VERTEX/SPOT_VAT_INPUT_COMPL` (пакет `/VERTEX/SPOT`)  
(також існує однойменний enhancement spot: `ENHS/XS`, але сам виконуваний об’єкт — програма)

**SFTP-методи / механізми:**  
- не виявлено (ні FM/класів для SFTP, ні `SXPG_COMMAND_EXECUTE`/SM69, ні згадок `SFTP`)

**Докази (file:line — snippet):**
- `/VERTEX/SPOT_VAT_INPUT_COMPL:~1`  
  `REPORT /vertex/spot_vat_input_report ...`
- `/VERTEX/SPOT_VAT_INPUT_COMPL:download_selected_data`  
  `CALL METHOD /vertex/cl_spot=>create_file_new ... iv_gui_download = p_pc iv_filename = lv_filename ...`  
  (це створення/завантаження файлу локально/на сервер, без мережевих протоколів)
- `/VERTEX/SPOT_VAT_INPUT_COMPL:validate_file_name`  
  `CALL METHOD /vertex/cl_spot=>validate_file_name EXPORTING iv_pc = p_pc iv_app = p_server ...`
- SearchSource по пакету `/VERTEX/SPOT`:
  - запит `SFTP` → **0 збігів** (скановано 15 об’єктів, 14 сорсів)
  - запит `SXPG_COMMAND_EXECUTE` → **0 збігів** (скановано 15 об’єктів, 14 сорсів)

**Замітки:**
- Напрямок: **push (експорт/даунлоад)** — програма формує файл `INP_VAT_<date><time>.TXT` і віддає його або на PC (`p_pc`), або на application server (`p_server`), але в наданому сорсі немає жодної реалізації передачі по SFTP.
- Якщо SFTP реалізовано, то потенційно воно могло б бути всередині `/vertex/cl_spot=>create_file_new` (але це інший об’єкт; у цьому репорті доказів SFTP немає).
