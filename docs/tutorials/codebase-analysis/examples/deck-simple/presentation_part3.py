"""Part 3 — Findings + mechanism + handoff/retro.

One slide per cluster, taken straight from the markdown reports.
"""

from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockMarginPreset,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
    DiagramCanvas,
    DiagramNode,
    DiagramConnection,
    NodeStyle,
    ConnectionLineStyle,
    ConnectionConnectorStyle,
)


INCH = 914400


YES = EPAMColor.Light_Teal
NO = EPAMColor.Light_Gray
DISC = EPAMColor.Light_Orange


def _report_line(name: str, sm69: str, direction: str, auth: str,
                 origin: str = "seed") -> ContentParagraph:
    tag = "•" if origin == "seed" else "+"
    return ContentParagraph(
        runs=[
            TextRun(text=f"{tag} ", bold=True,
                    color=YES if origin == "seed" else DISC),
            TextRun(text=name, bold=True),
            TextRun(text=f"  ·  SM69: {sm69}", italic=True),
            TextRun(text=f"  ·  {direction}  ·  {auth}"),
        ],
    )


def generate_part3(prs: EPAMPresentation):
    # ============================================================
    # Slide — Snapshot
    # ============================================================
    _, content_s = prs.add_default_slide(
        title="Snapshot",
        upsubtitle="13 SEEDS · 19 OBJECTS · +46%",
    )
    prs.add_block_grid(
        content_s,
        BlockGrid(
            left=0, top=0,
            width=content_s.width, height=int(2.0 * INCH),
            columns=5, gap=GapSize.SMALL,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      metric_value="19",
                      content="objects · 16 PROG + 3 FUGR",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Blue,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="11",
                      content="distinct SM69 commands",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Teal,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="8",
                      content="counter-party endpoints",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Orange,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="2",
                      content="auth modes · key + password",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Magenta,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="6 min",
                      content="wall-clock for whole run",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Gray,
                      horizontal_alignment=HorizontalAlignment.CENTER),
            ],
        ),
        background=Background.LIGHT,
    )
    prs.add_block(
        content_s,
        Block(
            left=0, bottom=0,
            width=content_s.width, height=int(1.2 * INCH),
            content=(
                "One underlying mechanism: SXPG_COMMAND_EXECUTE → SM69 entry → "
                "OS sftp/scp on the SAP application server."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.MEDIUM,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Seeds → reality
    # ============================================================
    _, content_v = prs.add_default_slide(
        title="Seeds → reality",
        upsubtitle="8 YES · 5 NO · +11 DISCOVERED",
    )

    seed_yes = [
        ("ZSFTP_CAPARIO_PULL",       "ZFTP_EOB_PULL"),
        ("ZSFTP_BNP_PARIBAS_PULL",   "ZFTP_BNPP_PULL"),
        ("ZSFTP_PATIENTCO_PULL",     "ZSFTP_PATCO_PULL"),
        ("ZSFTP_CAPARIO",            "ZFTP_837"),
        ("ZFFIU_ACC_POST",           "ZSFTP_CERIDIAN_GET"),
        ("ZDMS_UPLOAD_FILES",        "ZSFTP_DMS_GET / PUT"),
        ("ZSD_MEDICARE_PDF_PROCESS", "ZMEDI_* wrapper FMs"),
        ("ZSFTP_CITI_PULL",          "ZSFTP_CITI_PULL"),
    ]
    seed_no = [
        ("/VERTEX/SPOT_VAT_OUTPUT_COMPL", "local file I/O only"),
        ("/VERTEX/SPOT_VAT_INPUT_COMPL",  "local file I/O only"),
        ("ZEDI_835",                      "OPEN DATASET / GUI_UPLOAD"),
        ("ZFI_BANK_STMT_LOAD",            "local include processing"),
        ("ZEDI_835_JPM",                  "local file I/O only"),
    ]
    seed_paragraphs = []
    for name, mech in seed_yes:
        seed_paragraphs.append(ContentParagraph(
            runs=[
                TextRun(text="OK ", bold=True, color=YES),
                TextRun(text=name, bold=True),
                TextRun(text=f"  ·  {mech}", italic=True),
            ],
        ))
    for name, reason in seed_no:
        seed_paragraphs.append(ContentParagraph(
            runs=[
                TextRun(text="NO ", bold=True, color=NO),
                TextRun(text=name, bold=True),
                TextRun(text=f"  ·  {reason}", italic=True),
            ],
        ))

    discoveries = [
        "ZSFTP_BNP_PARIBAS · password-auth variant",
        "ZSFTP_BNP_PARIBAS_WITH_PGP · PGP push",
        "ZSFTP_CERIDIAN_PULL · operator duplicate",
        "ZSFTP_CITI_SEND · Citi outbound",
        "ZSFTP_JPM · JPMorgan outbound",
        "ZSFTP_JPM_PULL · JPMorgan inbound",
        "ZDMS_REPLACE_FILES · shares DMS SM69",
        "ZSD_ERX_DMS_FILE_PROCESS · via ZERX wrapper",
        "ZMEDICARE · wrapper FUGR",
        "ZERX · wrapper FUGR",
        "ZDMS_SEND_FILE · 0 literal callers (verify)",
    ]
    disc_paragraphs = [
        ContentParagraph(
            runs=[TextRun(text="+ ", bold=True, color=DISC),
                  TextRun(text=d)],
        ) for d in discoveries
    ]

    prs.add_block_grid(
        content_v,
        BlockGrid(
            left=0, top=0,
            width=content_v.width, height=content_v.height,
            columns=2, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.EXTRA_SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="13 seed verdicts",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Gray,
                      rich_content=seed_paragraphs),
                Block(left=0, top=0, width=0, height=0,
                      title="+11 discovered beyond seeds",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Gray,
                      rich_content=disc_paragraphs),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Banking (7 reports)
    # ============================================================
    _, content_b = prs.add_default_slide(
        title="Banking · 7 reports",
        upsubtitle="BNP PARIBAS · CITI · JPMORGAN",
    )
    banking_lines = [
        _report_line("ZSFTP_BNP_PARIBAS_PULL",     "ZFTP_BNPP_PULL",  "pull", "hybrid"),
        _report_line("ZSFTP_BNP_PARIBAS",          "ZFTP_BNPP",       "push", "password", "discovered"),
        _report_line("ZSFTP_BNP_PARIBAS_WITH_PGP", "ZFTP_BNPP",       "push + PGP", "key", "discovered"),
        _report_line("ZSFTP_CITI_PULL",            "ZSFTP_CITI_PULL", "pull", "key"),
        _report_line("ZSFTP_CITI_SEND",            "ZSFTP_CITI_SEND", "push", "key", "discovered"),
        _report_line("ZSFTP_JPM",                  "ZFTP_JPM",        "push", "key", "discovered"),
        _report_line("ZSFTP_JPM_PULL",             "ZFTP_JPM_PULL",   "pull", "key", "discovered"),
    ]
    prs.add_block(
        content_b,
        Block(
            left=0, top=0,
            width=content_b.width, height=content_b.height,
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Payload: ", bold=True),
                          TextRun(text="MT940 statements (pull) · payments + remittance (push) · "
                                       "PGP layer on BNP push.")],
                ),
                *banking_lines,
                ContentParagraph(
                    runs=[TextRun(text="! ", bold=True, color=DISC),
                          TextRun(text="ZFTP_BNPP", bold=True),
                          TextRun(text=" reused across password & key+PGP variants — migration risk to verify.")],
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Healthcare & payroll
    # ============================================================
    _, content_h = prs.add_default_slide(
        title="Healthcare claims & payroll · 5 reports",
        upsubtitle="CAPARIO · PATIENTCO · CERIDIAN",
    )
    hp_lines = [
        _report_line("ZSFTP_CAPARIO",       "ZFTP_837",          "push (EDI 837)", "key"),
        _report_line("ZSFTP_CAPARIO_PULL",  "ZFTP_EOB_PULL",     "pull (EOB)",     "key"),
        _report_line("ZSFTP_PATIENTCO_PULL","ZSFTP_PATCO_PULL",  "pull",           "key"),
        _report_line("ZFFIU_ACC_POST",      "ZSFTP_CERIDIAN_GET","pull",           "key"),
        _report_line("ZSFTP_CERIDIAN_PULL", "ZSFTP_CERIDIAN_GET","pull",           "key", "discovered"),
    ]
    prs.add_block(
        content_h,
        Block(
            left=0, top=0,
            width=content_h.width, height=content_h.height,
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Payload: ", bold=True),
                          TextRun(text="EDI 837 claims out / 835 ERA in · payroll postings into FI.")],
                ),
                *hp_lines,
                ContentParagraph(
                    runs=[TextRun(text="! ", bold=True, color=DISC),
                          TextRun(text="ZSFTP_CERIDIAN_GET", bold=True),
                          TextRun(text=" reused by two reports — consider consolidating to one entry point.")],
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — DMS / eRx
    # ============================================================
    _, content_d = prs.add_default_slide(
        title="DMS & eRx · 4 reports + 3 wrapper FUGRs",
        upsubtitle="INTERNAL DOCUMENT MANAGEMENT",
    )
    dms_lines = [
        _report_line("ZDMS_UPLOAD_FILES",        "ZSFTP_DMS_GET / PUT", "both", "key"),
        _report_line("ZDMS_REPLACE_FILES",       "ZSFTP_DMS_GET / PUT", "both", "key", "discovered"),
        _report_line("ZSD_MEDICARE_PDF_PROCESS", "ZMEDI_* wrapper",     "both", "key"),
        _report_line("ZSD_ERX_DMS_FILE_PROCESS", "ZERX_* wrapper",      "both", "key", "discovered"),
    ]
    prs.add_block(
        content_d,
        Block(
            left=0, top=0,
            width=content_d.width, height=content_d.height,
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Payload: ", bold=True),
                          TextRun(text="DMS documents in both directions · Medicare/eRx PDFs via wrapper FMs.")],
                ),
                *dms_lines,
                ContentParagraph(
                    runs=[TextRun(text="Wrapper FUGRs: ", bold=True),
                          TextRun(text="ZMEDICARE · ZERX · ZDMS_SEND_FILE "),
                          TextRun(text="(ZDMS_SEND_FILE — 0 literal callers; verify dynamic call or dead code).",
                                  italic=True)],
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Mechanism diagram
    # ============================================================
    _, content_m = prs.add_default_slide(
        title="One underlying mechanism · all 19 collapse to it",
        upsubtitle="SXPG · SM69 · OS BINARY",
    )

    nw = int(2.6 * INCH)
    nh = int(0.8 * INCH)
    gap = int(0.2 * INCH)
    rows = 5
    total_h = rows * nh + (rows - 1) * gap
    top_start = (content_m.height - total_h) // 2
    left = (content_m.width - nw) // 2

    nodes = [
        DiagramNode(left=left, top=top_start + 0 * (nh + gap), width=nw, height=nh,
                    text="ABAP caller", content="report or wrapper FM",
                    fill_color=EPAMColor.Light_Blue, style=NodeStyle.ROUNDED_RECTANGLE,
                    bold=True, font_size=13),
        DiagramNode(left=left, top=top_start + 1 * (nh + gap), width=nw, height=nh,
                    text="zfi_constants", content="credential bag · 11 entries",
                    fill_color=EPAMColor.Light_Gray, style=NodeStyle.STORAGE,
                    bold=True, font_size=13),
        DiagramNode(left=left, top=top_start + 2 * (nh + gap), width=nw, height=nh,
                    text="SXPG_COMMAND_EXECUTE",
                    content="ABAP-side single point",
                    fill_color=EPAMColor.Light_Orange, style=NodeStyle.ROUNDED_RECTANGLE,
                    bold=True, font_size=13),
        DiagramNode(left=left, top=top_start + 3 * (nh + gap), width=nw, height=nh,
                    text="SM69 entry",
                    content="11 Z-prefixed commands",
                    fill_color=EPAMColor.Light_Magenta, style=NodeStyle.ROUNDED_RECTANGLE,
                    bold=True, font_size=13),
        DiagramNode(left=left, top=top_start + 4 * (nh + gap), width=nw, height=nh,
                    text="OS sftp / scp",
                    content="-> 8 remote endpoints",
                    fill_color=EPAMColor.Light_Red, style=NodeStyle.ROUNDED_RECTANGLE,
                    bold=True, font_size=13),
    ]
    connections = [
        DiagramConnection(start_node_index=1, end_node_index=0,
                          style=ConnectionConnectorStyle.ELBOW,
                          line_style=ConnectionLineStyle.DASHED,
                          connection_text="read keys", end_arrow=True),
        DiagramConnection(start_node_index=0, end_node_index=2, end_arrow=True),
        DiagramConnection(start_node_index=2, end_node_index=3, end_arrow=True,
                          connection_text="commandname"),
        DiagramConnection(start_node_index=3, end_node_index=4, end_arrow=True),
    ]
    prs.add_diagram_canvas(
        content_m,
        DiagramCanvas(
            left=0, top=0,
            width=content_m.width, height=content_m.height,
            nodes=nodes, connections=connections,
            border=False,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Migration handoff + retro
    # ============================================================
    _, content_t = prs.add_default_slide(
        title="What the new SFTP layer must do · retro",
        upsubtitle="HANDOFF · LESSONS",
    )

    handoff_h = int(2.2 * INCH)
    prs.add_block_grid(
        content_t,
        BlockGrid(
            left=0, top=0,
            width=content_t.width, height=handoff_h,
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="Auth & direction",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Blue,
                      rich_content=[
                          ContentParagraph(text="Key-based AND password-based.", is_bullet=True),
                          ContentParagraph(text="Pull · push · both.", is_bullet=True),
                          ContentParagraph(text="PGP layer for BNP push.", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Surface to keep",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Teal,
                      rich_content=[
                          ContentParagraph(text="zfi_constants stays or 1:1 shim.", is_bullet=True),
                          ContentParagraph(text="11 SM69 endpoints · 1 per host.", is_bullet=True),
                          ContentParagraph(text="exitcode + exec_protocol semantics.", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Unknown to resolve",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Orange,
                      rich_content=[
                          ContentParagraph(text="OS-side script per SM69 · needs Basis.", is_bullet=True),
                          ContentParagraph(text="FTP_PORT customizing · non-defaults.", is_bullet=True),
                          ContentParagraph(text="ZDMS_SEND_FILE · zero callers.", is_bullet=True),
                      ]),
            ],
        ),
        background=Background.LIGHT,
    )

    retro_top = handoff_h + int(0.2 * INCH)
    retro_h = content_t.height - retro_top
    prs.add_block_grid(
        content_t,
        BlockGrid(
            left=0, top=retro_top,
            width=content_t.width, height=retro_h,
            columns=2, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="What worked",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Teal,
                      rich_content=[
                          ContentParagraph(
                              text="3-marker sweep (PRIVATE_KEY_PATH / FTP_PSWD / _FROM_SFTP) found +11 beyond seeds.",
                              is_bullet=True),
                          ContentParagraph(
                              text="Sequential single-keyword scans completed where AND-shape queries timed out.",
                              is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="What to improve",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Gray,
                      rich_content=[
                          ContentParagraph(
                              text="FUGR full-source read limited · enumerate FMs by name as workaround.",
                              is_bullet=True),
                          ContentParagraph(
                              text="Hardcoded SFTP without zfi_constants would slip past marker scan.",
                              is_bullet=True),
                      ]),
            ],
        ),
        background=Background.LIGHT,
    )


def test_part3():
    prs = EPAMPresentation(output_path="presentation_part3.pptx")
    generate_part3(prs)
    prs.save()
    print("Presentation created: presentation_part3.pptx")


if __name__ == "__main__":
    test_part3()
