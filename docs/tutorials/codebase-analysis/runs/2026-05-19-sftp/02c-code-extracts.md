# 02c-code-extracts — SFTP mechanism call sites (verbatim)

> Verbatim ABAP snippets for each of the 10 distinct SFTP mechanism artifacts (8 direct SM69 commands + 2 Z function-module wrappers).
> **Single underlying mechanism:** all 10 reduce to `CALL FUNCTION 'SXPG_COMMAND_EXECUTE'` invoking an SM69 entry, which in turn shells out to an OS-level sftp/scp binary on the application server. Migration replaces this one ABAP-level call.

## `ZFTP_EOB_PULL`

**Role:** SM69 command (Pharma / Caparío EOB pull)
**Caller report(s):** `ZSFTP_CAPARIO_PULL`

From `ZSFTP_CAPARIO_PULL`:

```abap
CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname           = p_comm
      additional_parameters = g_path
    IMPORTING
      exitcode              = g_ret_code
    TABLES
      exec_protocol         = i_return[].
```

---

## `ZFTP_BNPP_PULL`

**Role:** SM69 command (BNP Paribas bank statement)
**Caller report(s):** `ZSFTP_BNP_PARIBAS_PULL`

From `ZSFTP_BNP_PARIBAS_PULL`:

```abap
DATA: i_constants TYPE TABLE OF zfi_constants,
      i_log TYPE TABLE OF ty_log,
      i_return TYPE TABLE OF btcxpm WITH HEADER LINE,
      wa_log TYPE ty_log,
      wa_constants TYPE zfi_constants,
      g_ind TYPE c,
      g_path TYPE sxpgcolist-parameters,
      g_ret_code TYPE extcmdexex-exitcode.

PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_BNPP_PULL' .

START-OF-SELECTION.
  CLEAR: g_ind, g_path.
  SELECT * FROM zfi_constants INTO TABLE i_constants
                              WHERE pname = 'ZSFTP_BNP_PARIBAS'.
  IF NOT i_constants[] IS INITIAL.
    CLEAR wa_constants.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_USER'.
    IF sy-subrc NE 0.
      wa_log-msg = 'FTP_USER Parameter not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSEIF wa_constants-fval IS INITIAL.
      wa_log-msg = 'User name not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSE.
      g_path = wa_constants-fval.
    ENDIF.

    CLEAR wa_constants.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_PSWD'.
    IF sy-subrc NE 0.
      wa_log-msg = 'FTP_PSWD Parameter not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSEIF wa_constants-fval IS INITIAL.
      wa_log-msg = 'Password not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSE.
      CONCATENATE g_path ':' wa_constants-fval INTO g_path.
    ENDIF.
    CLEAR wa_constants.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_DOMAIN'.
    IF sy-subrc NE 0.
      wa_log-msg = 'FTP_DOMAIN Parameter not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSEIF wa_constants-fval IS INITIAL.
      wa_log-msg = 'Domain not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSE.
      CONCATENATE g_path '@' wa_constants-fval INTO g_path.
    ENDIF.

    CLEAR wa_constants.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FTP_PORT'.
    IF wa_constants-fval IS NOT INITIAL.
     CONCATENATE g_path ':' wa_constants-fval INTO g_path.
    ENDIF.

    CLEAR wa_constants.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FOLDER_PATH'.
    IF sy-subrc NE 0.
      wa_log-msg = 'FOLDER_PATH Parameter not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSEIF wa_constants-fval IS INITIAL.
      wa_log-msg = 'Folder path not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSE.
      CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.
    ENDIF.
    CLEAR wa_constants.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'FILE_EXT'.
    IF sy-subrc NE 0.
      wa_log-msg = 'FILE_EXT Parameter not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSEIF wa_constants-fval IS INITIAL.
      wa_log-msg = 'File Ext. not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSE.
      CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.
    ENDIF.
    CLEAR wa_constants.
    READ TABLE i_constants INTO wa_constants WITH KEY fnam = 'HOST_KEY'.
    IF sy-subrc NE 0.
      wa_log-msg = 'HOST_KEY Parameter not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSEIF wa_constants-fval IS INITIAL.
      wa_log-msg = 'Host Key not maintained'.
      APPEND wa_log-msg TO i_log.
      CLEAR wa_log.
      g_ind = 'X'.
    ELSE.
      CONCATENATE g_path  wa_constants-fval INTO g_path SEPARATED BY space.
    ENDIF.

  ELSE.
    wa_log-msg = 'FTP Parameters not maintained'.
    APPEND wa_log-msg TO i_log.
    CLEAR wa_log.
    g_ind = 'X'.
  ENDIF.

END-OF-SELECTION.
  IF g_ind = 'X'.
    LOOP AT i_log INTO wa_log.
      WRITE: / wa_log-msg.
    ENDLOOP.
  ELSE.
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname                   = p_comm
        additional_parameters         = g_path
      IMPORTING
*       STATUS                        =
        exitcode                      = g_ret_code
      TABLES
        exec_protocol                 = i_return[]
      EXCEPTIONS
        no_permission                 = 1
        command_not_found             = 2
        parameters_too_long           = 3
        security_risk                 = 4
        wrong_check_call_interface    = 5
        program_start_error           = 6
        program_termination_error     = 7
        x_error                       = 8
        parameter_expected            = 9
        too_many_parameters           = 10
        illegal_command               = 11
        wrong_asynchronous_parameters = 12
        cant_enq_tbtco_entry          = 13
        jobcount_generation_error     = 14
        OTHERS                        = 15.
```

---

## `ZSFTP_PATCO_PULL`

**Role:** SM69 command (Patientco)
**Caller report(s):** `ZSFTP_PATIENTCO_PULL`

From `ZSFTP_PATIENTCO_PULL`:

```abap
PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZSFTP_PATCO_PULL' .

    ...

    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = p_comm
        additional_parameters = g_path
      IMPORTING
        exitcode              = g_ret_code
      TABLES
        exec_protocol         = i_return[]
      EXCEPTIONS ...
```

---

## `ZFTP_837`

**Role:** SM69 command (EDI 837 healthcare claims)
**Caller report(s):** `ZSFTP_CAPARIO`

From `ZSFTP_CAPARIO`:

```abap
PARAMETERS: p_comm TYPE  sxpgcolist-name OBLIGATORY DEFAULT 'ZFTP_837' .
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = p_comm
        additional_parameters = g_path
      IMPORTING
        exitcode              = g_ret_code
      TABLES
        exec_protocol         = i_return[]
```

---

## `ZSFTP_CERIDIAN_GET`

**Role:** SM69 command (Ceridian payroll inbound)
**Caller report(s):** `ZFFIU_ACC_POST`

From `ZFFIU_ACC_POST`:

```abap
lv_comm = 'ZSFTP_CERIDIAN_GET'.
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = lv_comm
        additional_parameters = gv_param
```

---

## `ZSFTP_DMS_GET`

**Role:** SM69 command (DMS inbound files)
**Caller report(s):** `ZDMS_UPLOAD_FILES`

From `ZDMS_UPLOAD_FILES`:

```abap
lv_comm = 'ZSFTP_DMS_GET'.
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = lv_comm
        additional_parameters = gv_param
```

---

## `ZSFTP_DMS_PUT`

**Role:** SM69 command (DMS outbound files / error)
**Caller report(s):** `ZDMS_UPLOAD_FILES`

From `ZDMS_UPLOAD_FILES`:

```abap
lv_comm = 'ZSFTP_DMS_PUT'.
    ...
    CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = lv_comm
        additional_parameters = gv_param
```

---

## `ZSFTP_CITI_PULL`

**Role:** SM69 command (Citi bank statement / MT940)
**Caller report(s):** `ZSFTP_CITI_PULL`

From `ZSFTP_CITI_PULL`:

```abap
CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
      EXPORTING
        commandname           = p_comm
        additional_parameters = g_path
      IMPORTING
        exitcode              = g_ret_code
      TABLES
        exec_protocol         = i_return[]
```

From `ZSFTP_CITI_PULL`:

```abap
SELECT * FROM zfi_constants INTO TABLE i_constants
                              WHERE pname = 'ZSFTP_CITI'.
    ...
    PERFORM f_set_parameter USING 'SOURCE_FOLDER'     'M' ''.
    PERFORM f_set_parameter USING 'PASSPHRASE'        'M' ' '.
    PERFORM f_set_parameter USING 'FTP_USER'          'M' ' '.
    PERFORM f_set_parameter USING 'FTP_DOMAIN'        'M' '@'.
    PERFORM f_set_parameter USING 'HOST_KEY'          'M' ' '.
    PERFORM f_set_parameter USING 'PRIVATE_KEY_PATH'  'M' ' '.
```

From `ZSFTP_CITI_PULL`:

```abap
READ TABLE i_constants INTO wa_constants WITH KEY fnam = p_key.
    ...
    IF g_path IS INITIAL.
      g_path = wa_constants-fval.
    ELSE.
      CONCATENATE g_path wa_constants-fval INTO g_path SEPARATED BY p_sep.
    ENDIF.
```

---

## `ZMEDI_GET_FROM_SFTP`

**Role:** Z function module — wrapper over SXPG
**Caller report(s):** `ZSD_MEDICARE_PDF_PROCESS`

From `ZSD_MEDICARE_PDF_PROCESS`:

```abap
FORM f_get_files_from_sftp .
    CALL FUNCTION 'ZMEDI_GET_FROM_SFTP'
      EXPORTING
        command   = 'ZSFTP_MEDICARE_GET'
        constants = 'ZSFTP_MEDICARE_IN'.
  ENDFORM.
```

---

## `ZMEDI_PUT_FROM_SFTP`

**Role:** Z function module — wrapper over SXPG
**Caller report(s):** `ZSD_MEDICARE_PDF_PROCESS`

From `ZSD_MEDICARE_PDF_PROCESS`:

```abap
FORM f_send_error_file_to_sftp .
    CALL FUNCTION 'ZMEDI_PUT_FROM_SFTP'
      EXPORTING
        command   = 'ZSFTP_MEDICARE_PUT'
        constants = 'ZSFTP_MEDICARE_OUT'.
  ENDFORM.
```

---

## ZMEDI function-module bodies (SXPG wrappers — full source)

These two FMs are the only non-direct mechanism. Their bodies prove that they internally call `SXPG_COMMAND_EXECUTE` with the same FTP_USER / HOST_KEY / PRIVATE_KEY_PATH parameter pattern as the direct-call reports — confirming all 10 mechanisms reduce to one.

```abap
FUNCTION zmedi_get_from_sftp
  IMPORTING
    command TYPE sxpgcolist-name
    constants TYPE bdc_prog
  TABLES
    return LIKE bapiret2 OPTIONAL.
























  DATA:
    lv_ret_code TYPE extcmdexex-exitcode,
    lv_comm     TYPE  sxpgcolist-name,
    lt_return   TYPE TABLE OF btcxpm WITH HEADER LINE.

  REFRESH: gt_constants, gt_log.
  CLEAR: gv_file, gv_ind.
  SELECT * FROM zfi_constants INTO TABLE gt_constants
                              WHERE pname = constants.
  lv_comm = command.

  IF NOT gt_constants[] IS INITIAL.
    PERFORM f_set_parameter USING 'FTP_USER'          'M' ''.
    PERFORM f_set_parameter USING 'PASSPHRASE'        'M' ':'.
    PERFORM f_set_parameter USING 'HOST_KEY'          'M' ';'.
    PERFORM f_set_parameter USING 'FTP_DOMAIN'        'M' ';'.
    PERFORM f_set_parameter USING 'PRIVATE_KEY_PATH'  'M' ';'.
    PERFORM f_set_parameter USING 'SFTP_FILE_EXT'     'M' ';'.
    PERFORM f_set_parameter USING 'SOURCE_PATH'       'M' ';'.
    PERFORM f_set_parameter USING 'SOURCE_FOLDER'     'M' ''.
    PERFORM f_set_parameter USING 'ECS_FILE_EXT'      'M' ';'.
    PERFORM f_set_parameter USING 'ZDEST_FOLD'        'M' ';'.
  ENDIF.


  CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname                   = lv_comm
      additional_parameters         = gv_param
    IMPORTING
      exitcode                      = lv_ret_code
    TABLES
      exec_protocol                 = lt_return[]
    EXCEPTIONS
      no_permission                 = 1
      command_not_found             = 2
      parameters_too_long           = 3
      security_risk                 = 4
      wrong_check_call_interface    = 5
      program_start_error           = 6
      program_termination_error     = 7
      x_error                       = 8
      parameter_expected            = 9
      too_many_parameters           = 10
      illegal_command               = 11
      wrong_asynchronous_parameters = 12
      cant_enq_tbtco_entry          = 13
      jobcount_generation_error     = 14
      OTHERS                        = 15.
  IF sy-subrc = 0.
    CLEAR:gv_param.
  ENDIF.

  IF gt_log[] IS NOT INITIAL.
    return[] = gt_log[].
  ENDIF.

ENDFUNCTION.
```

```abap
FUNCTION zmedi_put_from_sftp
  IMPORTING
    command TYPE sxpgcolist-name
    constants TYPE bdc_prog
  TABLES
    return LIKE bapiret2 OPTIONAL.
































  DATA:
    lv_ret_code TYPE extcmdexex-exitcode,
    lv_comm     TYPE  sxpgcolist-name VALUE 'ZSFTP_MEDICARE_PUT',
    lt_return   TYPE TABLE OF btcxpm WITH HEADER LINE,
    lv_value    TYPE string,
    lv_status   TYPE btcxpgstat,
    g_ret_code  TYPE extcmdexex-exitcode.

  REFRESH: gt_constants.
  CLEAR: gv_file, gv_ind.
  SELECT * FROM zfi_constants INTO TABLE gt_constants
                              WHERE pname = constants.
  lv_comm = command.

  IF NOT gt_constants[] IS INITIAL.
    PERFORM f_set_parameter_out USING 'FTP_USER'          'M' ''   CHANGING lv_value.
    PERFORM f_set_parameter_out USING 'PASSPHRASE'        'M' ':'  CHANGING lv_value.
    PERFORM f_set_parameter_out USING 'HOST_KEY'          'M' ';'  CHANGING lv_value.
    PERFORM f_set_parameter_out USING 'FTP_DOMAIN'        'M' ';'  CHANGING lv_value.
    PERFORM f_set_parameter_out USING 'SOURCE_FOLDER'     'M' ';'  CHANGING lv_value.
    PERFORM f_set_parameter_out USING 'ZDEST_FOLD'        'M' ';'  CHANGING lv_value.
  ENDIF.

  CALL FUNCTION 'SXPG_COMMAND_EXECUTE'
    EXPORTING
      commandname                   = lv_comm
      additional_parameters         = gv_param
    IMPORTING
      status                        = lv_status
      exitcode                      = g_ret_code
    TABLES
      exec_protocol                 = lt_return[]
    EXCEPTIONS
      no_permission                 = 1
      command_not_found             = 2
      parameters_too_long           = 3
      security_risk                 = 4
      wrong_check_call_interface    = 5
      program_start_error           = 6
      program_termination_error     = 7
      x_error                       = 8
      parameter_expected            = 9
      too_many_parameters           = 10
      illegal_command               = 11
      wrong_asynchronous_parameters = 12
      cant_enq_tbtco_entry          = 13
      jobcount_generation_error     = 14
      OTHERS                        = 15.

  IF gt_log[] IS NOT INITIAL.
    return[] = gt_log[].
  ENDIF.


ENDFUNCTION.
```
