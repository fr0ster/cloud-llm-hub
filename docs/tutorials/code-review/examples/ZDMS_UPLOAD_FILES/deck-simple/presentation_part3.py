"""Part 3 — Section 02 Findings (per category) + Wrap.

One slide per category. Findings come straight from the markdown reports,
compact but with id · location · title · fix.
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
)


SEV_COLOR = {
    "H": EPAMColor.Light_Orange,
    "M": EPAMColor.Light_Teal,
    "L": EPAMColor.Light_Gray,
    "C": EPAMColor.Light_Red,
}


def _finding_paragraph(sev: str, fid: int, loc: str, title: str, fix: str) -> ContentParagraph:
    """One finding rendered as a single bullet line.

    Format:  [H] #1 · loc · title — fix
    """
    return ContentParagraph(
        runs=[
            TextRun(text=f"[{sev}] ", bold=True, color=SEV_COLOR[sev]),
            TextRun(text=f"#{fid} · {loc}", italic=True),
            TextRun(text=f" · {title} "),
            TextRun(text=f"— {fix}", bold=True),
        ],
        is_bullet=True,
    )


def _short_paragraph(sev: str, fid: int, loc: str, title: str) -> ContentParagraph:
    """Compact paragraph for very long lists (maintainability)."""
    return ContentParagraph(
        runs=[
            TextRun(text=f"[{sev}] ", bold=True, color=SEV_COLOR[sev]),
            TextRun(text=f"#{fid} · {loc} · ", italic=True),
            TextRun(text=title),
        ],
        is_bullet=True,
    )


def generate_part3(prs: EPAMPresentation):
    # ============================================================
    # Slide — Snapshot (severity row)
    # ============================================================
    _, content_s = prs.add_default_slide(
        title="Severity snapshot",
        upsubtitle="0C · 10H · 3M · 17L · 6 MIN",
    )
    prs.add_block_grid(
        content_s,
        BlockGrid(
            left=0, top=0,
            width=content_s.width, height=int(2.0 * 914400),
            columns=5, gap=GapSize.SMALL,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      metric_value="0", content="CRITICAL",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Red,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="10", content="HIGH",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Orange,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="3", content="MEDIUM",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Teal,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="17", content="LOW",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Gray,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="6 min", content="Wall-clock · 4 parallel",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Blue,
                      horizontal_alignment=HorizontalAlignment.CENTER),
            ],
        ),
        background=Background.LIGHT,
    )

    # Verdict callout
    prs.add_block(
        content_s,
        Block(
            left=0, bottom=0,
            width=content_s.width, height=int(1.2 * 914400),
            content=(
                "Significant rework needed. "
                "6 Clean Core HIGH findings — would not run on S/4HANA Cloud as-is."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.MEDIUM,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Security
    # ============================================================
    _, content_sec = prs.add_default_slide(
        title="Security · 4 findings",
        upsubtitle="2 HIGH · 1 MEDIUM · 1 LOW",
    )
    prs.add_block(
        content_sec,
        Block(
            left=0, top=0,
            width=content_sec.width, height=content_sec.height,
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                _finding_paragraph(
                    "H", 1, "F01:~250",
                    "AUTHORITY-CHECK missing before SXPG (SFTP GET)",
                    "Add S_LOG_COM / S_RZL_ADM check; fail closed."),
                _finding_paragraph(
                    "H", 2, "F01:~320",
                    "AUTHORITY-CHECK missing before SXPG (SFTP PUT)",
                    "Same; centralize in wrapper FORM."),
                _finding_paragraph(
                    "M", 3, "F01:~420",
                    "Shell-injection: additional_parameters built by CONCATENATE",
                    "Allowlist+escape, or use SM69 with no extra params."),
                _finding_paragraph(
                    "L", 4, "F01:~385",
                    "OPEN DATASET error message exposed via WRITE",
                    "Log technical details to SLG1; show generic message."),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Performance
    # ============================================================
    _, content_perf = prs.add_default_slide(
        title="Performance · 4 findings",
        upsubtitle="2 HIGH · 2 MEDIUM",
    )
    prs.add_block(
        content_perf,
        Block(
            left=0, top=0,
            width=content_perf.width, height=content_perf.height,
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                _finding_paragraph(
                    "H", 1, "F01:~235",
                    "FORMAT_MESSAGE called inside loop",
                    "Cache per unique (id,number,v1..v4) key; reuse."),
                _finding_paragraph(
                    "H", 2, "F01:~205",
                    "ZDMS_UPLOAD_DOCUMENTS called per row",
                    "Use mass-API table param; or aRFC/batch parallelism."),
                _finding_paragraph(
                    "M", 3, "F01:~120",
                    "SELECT * from TVARVC",
                    "Select only fields used (name/type/value)."),
                _finding_paragraph(
                    "M", 4, "F01:~150",
                    "SELECT * from DMS_DOC_FILES",
                    "Fetch only `filename` (or required key fields)."),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Clean Core
    # ============================================================
    _, content_cc = prs.add_default_slide(
        title="Clean Core · 6 findings",
        upsubtitle="6 HIGH · BLOCKS S/4HANA CLOUD",
    )
    prs.add_block(
        content_cc,
        Block(
            left=0, top=0,
            width=content_cc.width, height=content_cc.height,
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                _finding_paragraph(
                    "H", 1, "F01:~325",
                    "SXPG_COMMAND_EXECUTE (shell access)",
                    "Move SFTP to BTP/Integration Suite or HTTP API."),
                _finding_paragraph(
                    "H", 2, "F01:~388",
                    "SXPG_COMMAND_EXECUTE (shell access, 2nd)",
                    "Same — eliminate OS layer entirely."),
                _finding_paragraph(
                    "H", 3, "F01:~468",
                    "OPEN/READ/TRANSFER DATASET (AL11)",
                    "Use released DMS/attachment APIs or external store."),
                _finding_paragraph(
                    "H", 4, "F01:~494",
                    "DELETE DATASET (AL11)",
                    "Lifecycle in external content store with released API."),
                _finding_paragraph(
                    "H", 5, "F01:~656",
                    "DELETE DATASET (AL11, 2nd)",
                    "Same as above."),
                _finding_paragraph(
                    "H", 6, "F01:~164",
                    "Direct TVARVC read",
                    "Use released config API or wrap behind Z-API."),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Maintainability (17 findings, 2-column compact list)
    # ============================================================
    _, content_m = prs.add_default_slide(
        title="Maintainability · 17 findings",
        upsubtitle="ALL LOW · STYLE & READABILITY",
    )

    left_col = [
        _short_paragraph("L", 1, "F01:33", "Obsolete CONCATENATE → string templates"),
        _short_paragraph("L", 2, "F01:54", "Magic value for `color` control"),
        _short_paragraph("L", 3, "F01:61", "Magic literals for color codes"),
        _short_paragraph("L", 4, "F01:332", "Obsolete WITH HEADER LINE"),
        _short_paragraph("L", 5, "F01:411", "Obsolete WITH HEADER LINE (2nd)"),
        _short_paragraph("L", 6, "F01:103", "Commented-out code left in place"),
        _short_paragraph("L", 7, "F01:137", "Obsolete SPLIT → FIND REGEX"),
        _short_paragraph("L", 8, "F01:90", "Dead variable `lv_userid`"),
        _short_paragraph("L", 9, "F01:237", "Mixed inline + explicit DATA"),
    ]
    right_col = [
        _short_paragraph("L", 10, "F01:171", "Magic literals for messages"),
        _short_paragraph("L", 11, "F01:171", "Obsolete CONCATENATE in messages"),
        _short_paragraph("L", 12, "F01:237", "Magic constant `'AU1'` (dokar)"),
        _short_paragraph("L", 13, "F01:192", "Commented-out ENDIF"),
        _short_paragraph("L", 14, "F01:260", "Hard-coded allowed chars string"),
        _short_paragraph("L", 15, "F01:509", "Obsolete CONCATENATE for paths"),
        _short_paragraph("L", 16, "F01:579", "Missing FORM parameter typing"),
        _short_paragraph("L", 17, "F01:varied",
                         "Cumulative · adopt ABAP Cleaner ruleset"),
    ]

    prs.add_block_grid(
        content_m,
        BlockGrid(
            left=0, top=0,
            width=content_m.width, height=content_m.height,
            columns=2, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.EXTRA_SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Gray,
                      rich_content=left_col),
                Block(left=0, top=0, width=0, height=0,
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Gray,
                      rich_content=right_col),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Top priorities + retro
    # ============================================================
    _, content_t = prs.add_default_slide(
        title="Top priorities & what we learned",
        upsubtitle="3 FIXES · 3 LESSONS",
    )

    INCH = 914400
    prio_h = int(1.8 * INCH)
    prs.add_block_grid(
        content_t,
        BlockGrid(
            left=0, top=0,
            width=content_t.width, height=prio_h,
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="P1 · Stop shell I/O",
                      content=(
                          "Replace SXPG/AL11 with released "
                          "integration. Unblocks Clean Core."
                      ),
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Red),
                Block(left=0, top=0, width=0, height=0,
                      title="P2 · Add AUTHORITY-CHECK",
                      content=(
                          "Before every SXPG. Fail closed. "
                          "Centralize in wrapper."
                      ),
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Orange),
                Block(left=0, top=0, width=0, height=0,
                      title="P3 · Hoist loop calls",
                      content=(
                          "Cache FORMAT_MESSAGE per key. "
                          "Switch to mass-API uploads."
                      ),
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Teal),
            ],
        ),
        background=Background.LIGHT,
    )

    retro_top = prio_h + int(0.2 * INCH)
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
                          ContentParagraph(text="Per-axis prompts kept categories clean.", is_bullet=True),
                          ContentParagraph(text="Parallel light-tool calls — zero backend stress.", is_bullet=True),
                          ContentParagraph(text="No source = no finding — no speculation.", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="What to improve",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Gray,
                      rich_content=[
                          ContentParagraph(text="Tighten maintainability clustering rules.", is_bullet=True),
                          ContentParagraph(text="Baseline /cost before each task for split.", is_bullet=True),
                          ContentParagraph(text="Promote recurring fixes into skills.", is_bullet=True),
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
