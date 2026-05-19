# 02-methods — SFTP verdicts (run 2026-05-19)

> Generated from `curl/stage-2/response-NN.sse`. Each verdict is a streaming `/v1/chat/completions` reply via the `ai-applications` proxy → cloud-llm-hub-srv (provider OpenAI, model `gpt-5.2`) → destination `DS4_CLH`.

## Summary

| # | Seed | Verdict | Tools fired |
|---|------|---------|-------------|
| 1 | `/VERTEX/SPOT_VAT_OUTPUT_COMPL` | **no** | SearchObject, ReadProgram, SearchSource, SearchSource, SearchSource |
| 2 | `/VERTEX/SPOT_VAT_INPUT_COMPL` | **no** | SearchObject, ReadProgram, HandlerGet, SearchSource, SearchSource |
| 3 | `ZEDI_835` | **unclear (include chain)** | SearchObject, ReadProgram, SearchSource, SearchSource, SearchSource |
| 4 | `ZSFTP_CAPARIO_PULL` | **yes** | SearchObject, ReadProgram, SearchSource |
| 5 | `ZFI_BANK_STMT_LOAD` | **unclear (include chain)** | SearchObject, ReadProgram, SearchSource, SearchSource, SearchSource |
| 6 | `ZSFTP_BNP_PARIBAS_PULL` | **yes** | SearchObject, ReadProgram, SearchSource |
| 7 | `ZSFTP_PATIENTCO_PULL` | **yes** | SearchObject, ReadProgram, SearchSource |
| 8 | `ZSFTP_CAPARIO` | **yes** | SearchObject, ReadProgram, SearchSource |
| 9 | `ZFIU_ACC_POST` | **unclear** | SearchObject |
| 10 | `ZEDI_835_JPM` | **no** | SearchObject, ReadProgram, GetProgFullCode, SearchSource |
| 11 | `ZDMS_UPLOAD_FILES` | **unclear** | SearchObject, ReadProgram, GetObjectInfo, SearchSource, SearchSource |
| 12 | `ZSD_MEDICARE_PDF_PROCESS` | **unclear** | SearchObject, ReadProgram, SearchSource, SearchObject, ReadProgram, ReadProgram |
| 13 | `ZSFTP_CITI_PULL` | **yes** | SearchObject, ReadProgram, SearchSource |

## Token usage (cloud-llm-hub side, Stage 2 only)

| Model | prompt | completion | total | requests |
|-------|--------|------------|-------|----------|
| `gpt-5.2` | 520,718 | 13,476 | 534,194 | 76 |
| `embedder` | 3,615 | 0 | 3,615 | 13 |
| **GRAND** |  |  | **537,809** |  |

## Verdict tally

- **yes**: 5
- **no**: 3
- **unclear**: 3
- **unclear (include chain)**: 2

## Per-seed verdicts

### 1. `/VERTEX/SPOT_VAT_OUTPUT_COMPL` — **no**

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

---

### 2. `/VERTEX/SPOT_VAT_INPUT_COMPL` — **no**

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

---

### 3. `ZEDI_835` — **unclear (include chain)**

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

---

### 4. `ZSFTP_CAPARIO_PULL` — **yes**

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

---

### 5. `ZFI_BANK_STMT_LOAD` — **unclear (include chain)**

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]


[SmartAgent: Executing SearchSource...]
1) **SearchObject (існування + тип)**  
- `ZFI_BANK_STMT_LOAD` знайдено як **PROG/P** (executable program), пакет **Z001**.  
  - **Доказ:** SearchObject result: `ZFI_BANK_STMT_LOAD  PROG/P  ...  Z001`

2) **ReadProgram (читання сорсу за типом)**  
Прочитаний active-сорс `ZFI_BANK_STMT_LOAD` містить лише виклик PERFORM і два INCLUDE, без будь-яких SFTP/SSH/OS-команд у main include.  
- **Докази (ZFI_BANK_STMT_LOAD:line — snippet):**
  - `ZFI_BANK_STMT_LOAD:1` — `REPORT zfi_bank_stmt_load.`
  - `ZFI_BANK_STMT_LOAD:2-3` — `INCLUDE zfi_bank_stmt_top.` / `INCLUDE zfi_bank_stmt_load_f01.`
  - `ZFI_BANK_STMT_LOAD:6-7` — `START-OF-SELECTION.` / `PERFORM f_upload_ebs.`

3) **SearchSource по пакету (підтвердження патернів)**  
Я зробив пошук у пакеті **Z001** по об’єктах, що відповідають масці `ZFI_BANK_STMT*`:

- Пошук `SFTP` → **нічого не знайдено**.  
  - **Доказ:** SearchSource results: `[]` (scanned objects=2)
- Пошук `SXPG_COMMAND_EXECUTE` → **нічого не знайдено**.  
  - **Доказ:** SearchSource results: `[]` (scanned objects=2)

(Додатково: знаходиться робота з файлами через `OPEN DATASET`, але це в іншому репорті `ZFI_BANK_STMT_LOAD_NEW`, не в `ZFI_BANK_STMT_LOAD`.)  
- **Доказ:** `ZFI_BANK_STMT_LOAD_NEW:87` — `open dataset upl_file_name for input ...`

---

## Висновок

**Verdict:** **unclear**  
(бо `ZFI_BANK_STMT_LOAD` сам лише підключає `INCLUDE zfi_bank_stmt_top` та `INCLUDE zfi_bank_stmt_load_f01`, але я не маю їхнього тексту через доступні інструменти ReadProgram — отже не можу підтвердити/спростувати SFTP без доказів із цих include)

**Тип:** **PROG** (`PROG/P`)

**SFTP-методи / механізми:**  
- **Не підтверджено**: у просканованих сорсах по `ZFI_BANK_STMT*` в пакеті `Z001` **нема** ні `SFTP`, ні `SXPG_COMMAND_EXECUTE` (тобто немає доказів legacy OS-shell SFTP через SM69), і в main include програми немає SFTP-логіки.

**Докази (file:line — snippet):**
- `ZFI_BANK_STMT_LOAD:2-3` — `INCLUDE zfi_bank_stmt_top.` / `INCLUDE zfi_bank_stmt_load_f01.`
- SearchSource(Z001, `ZFI_BANK_STMT*`, query=`SFTP`) → results `[]`
- SearchSource(Z001, `ZFI_BANK_STMT*`, query=`SXPG_COMMAND_EXECUTE`) → results `[]`

**Замітки:**  
- Напрямок (push/pull), endpoint/host, ключі/паролі — **не видно** в доступному сорсі `ZFI_BANK_STMT_LOAD`; ймовірна логіка (якщо є) сидить в include `zfi_bank_stmt_load_f01` (PERFORM `f_upload_ebs` натякає на “upload”, але **це не доказ SFTP**).

Якщо скажеш точні імена include-об’єктів (чи це окремі програми `ZFI_BANK_STMT_TOP`, `ZFI_BANK_STMT_LOAD_F01` або інклуди в складі цього ж репорту), я зможу їх знайти через SearchObject/ReadProgram і тоді дати **yes/no** з конкретними snippet’ами.

---

### 6. `ZSFTP_BNP_PARIBAS_PULL` — **yes**

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

---

### 7. `ZSFTP_PATIENTCO_PULL` — **yes**

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

---

### 8. `ZSFTP_CAPARIO` — **yes**

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

---

### 9. `ZFIU_ACC_POST` — **unclear**

[SmartAgent: Executing SearchObject...]
Не можу виконати кроки 2–3, бо на цьому системному ландшафті **не знаходиться жодного ABAP-об’єкта з ім’ям `ZFIU_ACC_POST`** (SearchObject повернув порожній результат).

**Verdict:** unclear  
**Тип:** unknown (об’єкт не знайдено)  
**SFTP-методи / механізми:** — (немає що підтверджувати без сорсу)

**Докази (tool output):**
- `SearchObject('ZFIU_ACC_POST')` → **0 results** (об’єкт відсутній у репозиторії, який доступний через ці інструменти)

**Замітки:**
- Якщо об’єкт існує у вашій системі, але не знаходиться тут, можливі причини: інша система/клієнт, інше точне ім’я (суфікси/префікси), об’єкт є не PROG/CLAS/FUGR (наприклад, транзакція/варіант/джоб-нейм), або обмеження доступу/індексації.
- Дай, будь ласка, **точне ім’я** (можливо `ZFIU_ACC_POST_*`), або **тип** (PROG/CLAS/FUGR/FM) чи **пакет** — тоді я повторю 1) підтвердження, 2) читання сорсу, 3) SearchSource по пакету і зберу SFTP-докази (SXPG_COMMAND_EXECUTE / SM69-команди / SSH-параметри тощо).

---

### 10. `ZEDI_835_JPM` — **no**

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

---

### 11. `ZDMS_UPLOAD_FILES` — **unclear**

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

---

### 12. `ZSD_MEDICARE_PDF_PROCESS` — **unclear**

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

---

### 13. `ZSFTP_CITI_PULL` — **yes**

[SmartAgent: Executing SearchObject...]


[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing SearchSource...]
**Verdict:** yes  
**Тип:** PROG (executable program) — `ZSFTP_CITI_PULL`

**SFTP-методи / механізми:**
- `SXPG_COMMAND_EXECUTE` (legacy OS-shell виклик через SM69), SM69-команда: `ZSFTP_CITI_PULL` (параметр `p_comm`)

**Докази (file:line — snippet):**
- `ZSFTP_CITI_PULL:16` — `PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZSFTP_CITI_PULL'.`
- `ZSFTP_CITI_PULL:45-49` — `CALL FUNCTION 'SXPG_COMMAND_EXECUTE' ... commandname = p_comm  additional_parameters = g_path`
- `ZSFTP_CITI_PULL:24-30` — асемблюються параметри, характерні для SFTP/SSH:
  - `PERFORM f_set_parameter USING 'PASSPHRASE' ...`
  - `PERFORM f_set_parameter USING 'FTP_USER' ...`
  - `PERFORM f_set_parameter USING 'HOST_KEY' ...`
  - `PERFORM f_set_parameter USING 'PRIVATE_KEY_PATH' ...`
- `ZSFTP_CITI_PULL:86-93` — збірка `additional_parameters` в один рядок:
  - `CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY p_sep.`

**Замітки:**
- Напрямок: **pull** (з опису програми) — `description="Pull MT940 into AL11 from citi"` (метадані ReadProgram).
- Endpoint/host hints: у коді напряму не видно host/URL; параметри беруться з таблиці `ZFI_CONSTANTS` для `pname = 'ZSFTP_CITI'` (`ZSFTP_CITI_PULL:19-21`), тобто host/endpoint, ймовірно, заховані в кастомайзінгу.
- Що читається/пишеться: фактичний transfer робиться зовнішньою OS-командою (SM69) з параметрами `g_path`; сам ABAP лише формує параметри й виводить `exec_protocol` (`ZSFTP_CITI_PULL:45-74`).

---
