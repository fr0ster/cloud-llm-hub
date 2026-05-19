# ZFI_BANK_STMT_LOAD

Tools: SearchObject, ReadProgram, SearchSource, SearchSource, SearchSource



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
