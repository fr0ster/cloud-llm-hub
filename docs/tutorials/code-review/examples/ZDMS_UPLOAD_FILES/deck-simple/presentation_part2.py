from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockProcess,
    BlockStyle,
    ProcessDirection,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)


def generate_part2(prs: EPAMPresentation):
    # ----- Slide 4 — Section divider: Target (Section Header Dark) -----
    prs.add_section_header_slide_dark(
        section_number="01",
        section_title="Target",
        section_description=(
            "Legacy ABAP report ZDMS_UPLOAD_FILES — SFTP file transfer via OS "
            "shell commands. One program, every include in scope."
        ),
    )

    # ----- Slide 5 — What we reviewed (Default Slide, Title + Upsubtitle) -----
    slide5, content5 = prs.add_default_slide(
        title="ZDMS_UPLOAD_FILES",
        upsubtitle="REPORT · Z001 · DS4_CLH",
    )

    review_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="What it does",
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Pulls files via SFTP GET → SAP DMS upload")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Pushes files via SFTP PUT")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="Driven by SM69 entries "),
                        TextRun(text="ZSFTP_DMS_GET", bold=True),
                        TextRun(text=" / "),
                        TextRun(text="ZSFTP_DMS_PUT", bold=True),
                    ],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Processes",
            icon_name="Gear_Process_1",
            text_size=TextSize.MEDIUM,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="How it does it",
            rich_content=[
                ContentParagraph(
                    runs=[
                        TextRun(text="SXPG_COMMAND_EXECUTE", bold=True),
                        TextRun(text=" → OS shell"),
                    ],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="OPEN / READ / TRANSFER / DELETE DATASET", bold=True),
                        TextRun(text=" on app server"),
                    ],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="Reads config from standard "),
                        TextRun(text="TVARVC", bold=True),
                    ],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Teal,
            icon_category="Buildings_Construction",
            icon_name="Hammer_Screwdriver",
            text_size=TextSize.MEDIUM,
        ),
    ]

    prs.add_block_grid(
        content5,
        BlockGrid(
            left=0,
            top=0,
            width=content5.width,
            height=content5.height,
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=review_blocks,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 6 (NEW) — How we ran the review (pipeline) -----
    slide6, content6 = prs.add_default_slide(
        title="How we ran the review",
        upsubtitle="READ-ONLY · PARALLEL · CITED",
    )

    pipeline_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="1. Read source",
            content=(
                "ReadProgram + GetIncludesList + GetInclude × N. "
                "Whole program + every include in scope."
            ),
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Documents",
            icon_name="Document_Layout",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="2. Four parallel checks",
            content=(
                "Four SmartAgent calls fire concurrently — one per category, "
                "each with its own rule set and severity scale."
            ),
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Processes",
            icon_name="Process_Parallel" if False else "Gear_Process_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="3. Aggregate",
            content=(
                "Parse per-finding ### headings → severity histogram → "
                "cross-category verdict. ~6 min wall-clock total."
            ),
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Data_Analytics_Charts",
            icon_name="Bar_Graph_Increasing_1",
            text_size=TextSize.SMALL,
        ),
    ]

    pipeline_height = 3200000
    prs.add_block_process(
        content6,
        BlockProcess(
            direction=ProcessDirection.HORIZONTAL,
            left=0,
            top=0,
            width=content6.width,
            height=pipeline_height,
            blocks=pipeline_blocks,
            gap=GapSize.MEDIUM,
            arrow_color=EPAMColor.Light_Gray,
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content6,
        Block(
            left=0,
            top=pipeline_height + 274320,
            width=content6.width,
            height=0,
            content=(
                "Comparable senior-engineer manual review: 4–8 hours "
                "(1–2 hours per category × 4)."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
            horizontal_alignment=HorizontalAlignment.LEFT,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 7 (NEW) — Discipline that made the run safe -----
    slide7, content7 = prs.add_default_slide(
        title="What kept the run honest",
        upsubtitle="THREE DISCIPLINES IN PROMPTS",
    )

    discipline_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="Source citation rule",
            content=(
                "No source = no finding. Every finding carries Location + "
                "Snippet. Stops the agent from inventing issues."
            ),
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Checkmarks",
            icon_name="Checkmark_Circle_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Per-category isolation",
            content=(
                "Each check stays inside its own rule set. No security "
                "findings leaked into maintainability or vice versa."
            ),
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Teal,
            icon_category="Structures_Architectures",
            icon_name="Architecture_1" if False else "Diagram_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Read-only parallelism",
            content=(
                "Four parallel SmartAgent calls are safe because the tools "
                "are read-only (Read*). SearchSource would not be safe in parallel."
            ),
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Purple,
            icon_category="Processes",
            icon_name="Gear_Process_2",
            text_size=TextSize.SMALL,
        ),
    ]

    prs.add_block_grid(
        content7,
        BlockGrid(
            left=0,
            top=0,
            width=content7.width,
            height=content7.height,
            columns=1,
            gap=GapSize.SMALL,
            blocks=discipline_blocks,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 8 — Four rule sets in parallel (was slide 6) -----
    slide6, content6 = prs.add_default_slide(
        title="Four parallel category checks",
        upsubtitle="FOUR RULE SETS IN PARALLEL",
    )

    process_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="Security",
            content="Auth checks, OS-shell injection, info disclosure.",
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Advanced_Technology",
            icon_name="Security",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Performance",
            content="Wide SELECTs, per-row FM calls inside LOOP.",
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Data_Analytics_Charts",
            icon_name="Bar_Graph_Increasing_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Clean Core",
            content="S/4HANA Cloud readiness — released APIs only.",
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Cloud",
            icon_name="Cloud_Computing_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Maintainability",
            content="Style, modern ABAP, dead code.",
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Core_Engineering",
            icon_name="Engineering_Excellence",
            text_size=TextSize.SMALL,
        ),
    ]

    # Reserve room for a caption block below the process
    process_height = 3200000
    prs.add_block_process(
        content6,
        BlockProcess(
            direction=ProcessDirection.HORIZONTAL,
            left=0,
            top=0,
            width=content6.width,
            height=process_height,
            blocks=process_blocks,
            gap=GapSize.MEDIUM,
            arrow_color=EPAMColor.Light_Gray,
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content6,
        Block(
            left=0,
            top=process_height + 274320,
            width=content6.width,
            height=0,
            content=(
                "Tools used: ReadProgram, GetIncludesList, GetInclude. "
                "Read-only, parallel-safe."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
            horizontal_alignment=HorizontalAlignment.LEFT,
        ),
        background=Background.LIGHT,
    )


def test_part2():
    prs = EPAMPresentation(output_path="presentation_part2.pptx")
    generate_part2(prs)
    prs.save()
    print("Presentation created: presentation_part2.pptx")


if __name__ == "__main__":
    test_part2()
