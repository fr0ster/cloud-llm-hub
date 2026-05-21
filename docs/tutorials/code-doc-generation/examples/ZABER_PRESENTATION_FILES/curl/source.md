I'll execute this procedure exactly as specified.

[SmartAgent: Executing ReadProgram...]


[SmartAgent: Executing GetIncludesList...]
Now I'll retrieve each include:

[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]


[SmartAgent: Executing GetInclude...]
### MAIN: ZABER_PRESENTATION_FILES

```abap
*&---------------------------------------------------------------------*
*& Report ZABER_PRESENTATION_FILES
*&---------------------------------------------------------------------*
*&
*&---------------------------------------------------------------------*
REPORT zaber_presentation_files.
INCLUDE :
   zaber_presen_files_top,
   zaber_presen_files_ss,
   zaber_presen_files_f01.

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file.

  PERFORM get_filename.


START-OF-SELECTION.

  IF rb_crea = abap_true.

    gv_filename = sy-uname && ` ` && sy-datum && '.csv'.

    SELECT * FROM zaber_auth INTO TABLE @gt_users.

    PERFORM download_file USING  gv_filename.

    PERFORM send_email.

  ELSE.

    IF p_file IS INITIAL.
      MESSAGE 'Select a file' TYPE 'S' DISPLAY LIKE 'E'.
      RETURN.
    ENDIF.

    CASE abap_true.

      WHEN rb_disp.

        PERFORM upload_file.

        IF gt_users IS NOT INITIAL.
          CALL FUNCTION 'SRTT_TABLE_DISPLAY'
            EXPORTING
              table         = 'ZABER_AUTH'
              iv_title      = 'User List'
            TABLES
              table_content = gt_users.
        ENDIF.

      WHEN rb_add.

        PERFORM upload_file.

        APPEND INITIAL LINE TO gt_users ASSIGNING FIELD-SYMBOL(<ls_user>).
        <ls_user>-name = 'Andrey Berezkin'.

        gv_filename = p_file.

        PERFORM download_file USING gv_filename.


      WHEN rb_del.

        PERFORM delete_file.

    ENDCASE.

  ENDIF.
```

### INCLUDE: ZABER_PRESEN_FILES_F01

```abap
*&---------------------------------------------------------------------*
*& Include          ZABER_PRESEN_FILES_F01
*&---------------------------------------------------------------------*


FORM download_file USING iv_filename TYPE string.

  cl_gui_frontend_services=>gui_download( EXPORTING filename = CONV #( iv_filename )
                                              CHANGING data_tab = gt_users
                                              EXCEPTIONS OTHERS = 1 ).

  IF sy-subrc <> 0.
    MESSAGE 'Can not transfer data to file' TYPE 'S' DISPLAY LIKE 'E'.
    RETURN.
  ENDIF.



ENDFORM.

FORM upload_file .

  cl_gui_frontend_services=>gui_upload( EXPORTING filename = CONV #( p_file )
                                              CHANGING data_tab = gt_users
                                              EXCEPTIONS OTHERS = 1 ).
  IF sy-subrc IS NOT INITIAL.
    MESSAGE 'Can not open this file' TYPE 'S' DISPLAY LIKE 'E'.
    RETURN.
  ENDIF.

ENDFORM.

FORM delete_file.

  DATA: lv_rc TYPE i.

  cl_gui_frontend_services=>file_delete(  EXPORTING  filename = CONV #( p_file )
                                          CHANGING   rc       = lv_rc
                                          EXCEPTIONS OTHERS   = 1 ).
  IF sy-subrc <> 0.
    MESSAGE 'Can not delete this file, sorry' TYPE 'S' DISPLAY LIKE 'E'.
  ENDIF.

ENDFORM.

FORM get_filename.

  CALL FUNCTION 'F4_FILENAME'
    EXPORTING
      program_name  = sy-cprog
      dynpro_number = sy-dynnr
      field_name    = 'P_FILE'
    IMPORTING
      file_name     = p_file.

ENDFORM.

FORM send_email.
  DATA: lo_send_request TYPE REF TO cl_bcs,
        lo_sender_mail  TYPE REF TO cl_cam_address_bcs,
        lo_rec          TYPE REF TO if_recipient_bcs,
        lo_document     TYPE REF TO cl_document_bcs,

        lt_soli_tab     TYPE soli_tab,
        lt_solix        TYPE solix_tab,
        lt_convert      TYPE truxs_t_text_data,
        lt_html         TYPE TABLE OF w3html,
        lt_header       TYPE TABLE OF w3head,

        lv_sender_mail  TYPE adr6-smtp_addr,
        lv_mail         TYPE adr6-smtp_addr,
        lv_objdes       TYPE sood-objdes,
        lv_xstring      TYPE xstring,
        lv_string       TYPE string.

  FIELD-SYMBOLS: <ls_convert> LIKE LINE OF lt_convert,
                 <ls_soli>    LIKE LINE OF lt_soli_tab,
                 <ls_html>    LIKE LINE OF lt_html.

  TRY.

      "Create send request
      lo_send_request = cl_bcs=>create_persistent( ).

      "Email FROM...
      lv_sender_mail = 'andrey_berezkin@epam.com'.
      lo_sender_mail = cl_cam_address_bcs=>create_internet_address( i_address_string = lv_sender_mail
                                                                    i_address_name   = lv_sender_mail ).
      lo_send_request->set_sender( lo_sender_mail ).

      "Email TO...
      IF p_email IS NOT INITIAL.
        lv_mail = p_email.
        lo_rec = cl_cam_address_bcs=>create_internet_address( lv_mail ).
      ELSE.
        lo_rec = cl_sapuser_bcs=>create( sy-uname ).
      ENDIF.

      lo_send_request->add_recipient( i_recipient  = lo_rec
                                      i_express    = abap_true
                                      i_copy       = abap_true
                                      i_blind_copy = abap_false
                                      i_no_forward = ' ' ).

      CALL FUNCTION 'SOTR_SERV_TABLE_TO_STRING'
        IMPORTING
          text     = lv_string
        TABLES
          text_tab = gt_users.

      CALL FUNCTION 'SCMS_STRING_TO_XSTRING'
        EXPORTING
          text   = lv_string
        IMPORTING
          buffer = lv_xstring
        EXCEPTIONS
          OTHERS = 1.

      IF sy-subrc <> 0.
        MESSAGE 'Message not sent' TYPE 'S' DISPLAY LIKE 'E'.
        RETURN.
      ENDIF.

      APPEND INITIAL LINE TO lt_html ASSIGNING <ls_html>.
      <ls_html>-line = 'Additional body'.

      lt_solix = cl_bcs_convert=>xstring_to_solix( lv_xstring ).

      lv_objdes = 'file.csv'.

      lo_document = cl_document_bcs=>create_document( i_type = 'HTM' i_subject = 'New file is created' i_text = lt_html ).

      IF lv_xstring IS NOT INITIAL.

        lo_document->add_attachment( i_attachment_type = 'BIN' i_attachment_subject = lv_objdes i_att_content_hex = lt_solix ).

      ENDIF.

      lo_send_request->set_document( lo_document ).

      lo_send_request->set_send_immediately( abap_true ).

      lo_send_request->send( ).
    CATCH cx_document_bcs cx_send_req_bcs cx_address_bcs.
      MESSAGE 'Message not sent' TYPE 'S' DISPLAY LIKE 'E'.
      RETURN.
  ENDTRY.

  COMMIT WORK.
  MESSAGE 'Message is sent' TYPE 'S'.
ENDFORM.
```

### INCLUDE: ZABER_PRESEN_FILES_SS

```abap
*&---------------------------------------------------------------------*
*& Include          ZABER_PRESEN_FILES_SS
*&---------------------------------------------------------------------*
PARAMETERS: rb_crea RADIOBUTTON GROUP rb1 USER-COMMAND ucc.

SELECTION-SCREEN BEGIN OF BLOCK bl1 WITH FRAME.
  PARAMETERS: p_send  AS CHECKBOX DEFAULT 'X' USER-COMMAND ucb,
              p_email TYPE ad_smtpadr.
SELECTION-SCREEN END OF BLOCK bl1.

PARAMETERS: rb_disp RADIOBUTTON GROUP rb1,
            rb_del  RADIOBUTTON GROUP rb1,
            rb_add  RADIOBUTTON GROUP rb1,
            p_file  TYPE rlgrap-filename.
```

### INCLUDE: ZABER_PRESEN_FILES_TOP

```abap
*&---------------------------------------------------------------------*
*& Include          ZABER_PRESEN_FILES_TOP
*&---------------------------------------------------------------------*
DATA: gt_users TYPE TABLE OF zaber_auth.
DATA:  gv_filename TYPE string.
```