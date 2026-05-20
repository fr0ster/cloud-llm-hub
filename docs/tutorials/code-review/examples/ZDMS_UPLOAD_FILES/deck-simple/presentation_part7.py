from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockMarginPreset,
    ChevronProcess,
    ChevronStep,
    ProcessDirection,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    VerticalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)


# Severity → accent color (light-bg variants, per presentation.design)
_SEV_COLOR = {
    "CRITICAL": EPAMColor.Light_Red,
    "HIGH": EPAMColor.Light_Orange,
    "MEDIUM": EPAMColor.Light_Teal,
    "LOW": EPAMColor.Light_Gray,
}


def _cell(text: str, color: EPAMColor, bold: bool = False, size: int = 14) -> Block:
    """Compact heatmap cell — single line of text, centered."""
    return Block(
        left=0, top=0, width=0, height=0,
        rich_content=[
            ContentParagraph(
                runs=[TextRun(text=text, bold=bold, color=color, font_size=size)],
                alignment=HorizontalAlignment.CENTER,
            )
        ],
        style=BlockStyle.SIMPLE,
        horizontal_alignment=HorizontalAlignment.CENTER,
        vertical_alignment=VerticalAlignment.MIDDLE,
        margin_preset=BlockMarginPreset.NARROW,
    )


def generate_part7(prs: EPAMPresentation):
    # ----- Slide 20 — Section divider: Summary (Section Header Dark) -----
    prs.add_section_header_slide_dark(
        section_number="07",
        section_title="Summary",
        section_description=(
            "Cross-cutting picture, prioritized actions, and what the run "
            "itself cost."
        ),
    )

    # ----- Slide 21 — Findings heatmap (Default Slide, Title + Upsubtitle) -----
    slide21, content21 = prs.add_default_slide(
        title="Findings by category × severity",
        upsubtitle="WHERE THE WEIGHT SITS",
    )

    # Heatmap: 5 cols (label, CRITICAL, HIGH, MEDIUM, LOW) x 5 rows (header + 4 axes)
    HDR = EPAMColor.Light_Blue
    NEU = EPAMColor.Light_DarkGray
    cells: list[Block] = []
    # Header row
    cells.append(_cell("", NEU))
    cells.append(_cell("CRITICAL", _SEV_COLOR["CRITICAL"], bold=True))
    cells.append(_cell("HIGH", _SEV_COLOR["HIGH"], bold=True))
    cells.append(_cell("MEDIUM", _SEV_COLOR["MEDIUM"], bold=True))
    cells.append(_cell("LOW", _SEV_COLOR["LOW"], bold=True))

    # Data rows: (label, critical, high, medium, low)
    rows = [
        ("Security",        0, 2, 1, 1),
        ("Performance",     0, 2, 2, 0),
        ("Clean Core",      0, 6, 0, 0),
        ("Maintainability", 0, 0, 0, 16),
    ]
    for label, c_crit, c_high, c_med, c_low in rows:
        cells.append(_cell(label, HDR, bold=True))
        cells.append(_cell(str(c_crit), NEU))
        # HIGH column emphasised
        cells.append(_cell(str(c_high), _SEV_COLOR["HIGH"], bold=True, size=18))
        cells.append(_cell(str(c_med), NEU))
        cells.append(_cell(str(c_low), NEU))

    heatmap_height = 3600000  # ~3.94"
    prs.add_block_grid(
        content21,
        BlockGrid(
            left=0,
            top=0,
            width=content21.width,
            height=heatmap_height,
            columns=5,
            gap=GapSize.SMALL,
            blocks=cells,
            style=BlockStyle.SIMPLE,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # Totals caption below heatmap
    prs.add_block(
        content21,
        Block(
            left=0,
            top=heatmap_height + 274320,
            width=content21.width,
            height=0,
            content="TOTAL: 30 findings — 10 HIGH, 3 MEDIUM, 17 LOW, 0 CRITICAL.",
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.MEDIUM,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 22 — Verdict (Default Slide Dark, Title + Subtitle) -----
    slide22, content22 = prs.add_default_slide_dark(
        title="Significant rework needed",
        upsubtitle="ON-PREM OK · CLOUD BLOCKED",
    )

    verdict_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="Schedule a focused fix sprint",
            content=(
                "Address all 10 HIGH issues before next release — "
                "security and performance carry the urgency."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Migration call",
            content=(
                "6 HIGH Clean Core findings = rewrite the SFTP path "
                "before any S/4HANA Cloud move."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Cyan,
        ),
    ]
    prs.add_block_grid(
        content22,
        BlockGrid(
            left=0,
            top=0,
            width=content22.width,
            height=0,
            columns=2,
            gap=GapSize.LARGE,
            blocks=verdict_blocks,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
        ),
        background=Background.DARK,
    )

    # ----- Slide 23 — Recommended priorities (Default Slide, Title only) -----
    slide23, content23 = prs.add_default_slide(
        title="Recommended action order",
    )

    prs.add_chevron_process(
        content23,
        ChevronProcess(
            left=0,
            top=0,
            width=content23.width,
            height=content23.height,
            direction=ProcessDirection.HORIZONTAL,
            steps=[
                ChevronStep(
                    label="Now",
                    content=(
                        "Security — add AUTHORITY-CHECK before SXPG; "
                        "validate and escape parameters."
                    ),
                ),
                ChevronStep(
                    label="Next",
                    content=(
                        "Performance — pull FM calls out of LOOP; "
                        "narrow SELECT lists."
                    ),
                ),
                ChevronStep(
                    label="Plan",
                    content=(
                        "Clean Core — replace SXPG + AL11 with Integration "
                        "Suite / released APIs."
                    ),
                ),
                ChevronStep(
                    label="Ongoing",
                    content=(
                        "Maintainability — fix during normal evolution; "
                        "no dedicated sprint."
                    ),
                ),
            ],
            text_size=TextSize.SMALL,
            auto_color_rotation=False,
            color=EPAMColor.Light_Orange,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 24 — Retro: time & token cost (Default Slide, Title + Upsubtitle) -----
    slide24, content24 = prs.add_default_slide(
        title="Run economics",
        upsubtitle="AI VS MANUAL REVIEW",
    )

    retro_metrics = [
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="~6 min",
            content="Total wall-clock (vs 4–8 hours manual)",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Blue,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="~45 s",
            content="Slowest of 4 parallel category checks",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Teal,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="381k",
            content="Executor-side LLM tokens (gpt-5.2)",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Lavender,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="~$28",
            content="Controller-side share of session cost",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Orange,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
    ]
    metric_grid_height = 2400000
    prs.add_block_grid(
        content24,
        BlockGrid(
            left=0,
            top=0,
            width=content24.width,
            height=metric_grid_height,
            columns=4,
            gap=GapSize.MEDIUM,
            blocks=retro_metrics,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content24,
        Block(
            left=0,
            top=metric_grid_height + 274320,
            width=content24.width,
            height=0,
            content="30 findings, 4 categories, one parallel run.",
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.MEDIUM,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 25 — Retro: lessons (Default Slide, Title only) -----
    slide25, content25 = prs.add_default_slide(
        title="What we learned for the next run",
    )

    lessons = [
        Block(
            left=0, top=0, width=0, height=0,
            title="Worked well",
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Parallel category checks safe with read-only tools")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Per-category isolation — no rule leakage")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Strict source citation eliminated speculation")],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Green,
            icon_category="Checkmarks",
            icon_name="Checkmark_Circle_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Went off",
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Bash backtick expansion mangled rule text in prompts")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Severity-summary regex missed maintainability block")],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Red,
            icon_category="Checkmarks",
            icon_name="X_Mark_Circle_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Fix next time",
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Build prompts in Python end-to-end, no bash variables")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Parse severity from per-finding headings only")],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Orange,
            icon_category="Processes",
            icon_name="Gear_Process_2",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Don't change",
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="One worked example per pipeline is enough")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Keep parallelism only for read-only tool sets")],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Goals",
            icon_name="Thumbs_Up",
            text_size=TextSize.SMALL,
        ),
    ]

    prs.add_block_grid(
        content25,
        BlockGrid(
            left=0,
            top=0,
            width=content25.width,
            height=content25.height,
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=lessons,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 26 — Thank you / Q&A (Default Slide Dark, Title + Upsubtitle) -----
    prs.add_default_slide_dark(
        title="Questions?",
        upsubtitle="FULL ARTIFACTS IN TUTORIAL",
    )


def test_part7():
    prs = EPAMPresentation(output_path="presentation_part7.pptx")
    generate_part7(prs)
    prs.save()
    print("Presentation created: presentation_part7.pptx")


if __name__ == "__main__":
    test_part7()
