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

    # ----- Slide 6 — Review approach (Default Slide, Title + Upsubtitle) -----
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
