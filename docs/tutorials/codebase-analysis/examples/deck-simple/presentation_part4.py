from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockProcess,
    BlockMarginPreset,
    ProcessDirection,
    Text,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    VerticalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)


def generate_part4(prs: EPAMPresentation):
    # ---------------------------------------------------------------
    # Slide 10 — Section divider: "Usage Map" (Section Header Dark, "03")
    # ---------------------------------------------------------------
    prs.add_section_header_slide_dark(
        section_title="Usage Map",
        section_description=(
            "Seven independent SearchSource scans. Three credential-bag markers. "
            "Wrapper FUGRs discovered along the way."
        ),
        section_number="04",
    )

    # ---------------------------------------------------------------
    # Slide 11 — Scope expansion (Grey + White Split 2/3)
    # Left grey = hero number, right white = lineage breakdown
    # ---------------------------------------------------------------
    slide11, left11, right11 = prs.add_grey_and_white_split_slide(
        title="How the scope grew",
        section_title="Scope grew",
        grey_width_ratio="2/3",
    )

    # Left: hero metric "+46%"
    prs.add_block(
        left11,
        Block(
            left=0,
            top=0,
            width=left11.width,
            height=left11.height,
            metric_value="+46%",
            content="vs the 13-seed stakeholder list (13 → 19 confirmed objects).",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Orange,
            horizontal_alignment=HorizontalAlignment.CENTER,
            vertical_alignment=VerticalAlignment.MIDDLE,
        ),
        background=Background.LIGHT,
    )

    # Right: stacked compact blocks (one per scan finding)
    prs.add_block_grid(
        right11,
        BlockGrid(
            left=0,
            top=0,
            width=right11.width,
            height=0,
            columns=1,
            gap=GapSize.SMALL,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Scan PRIVATE_KEY_PATH",
                    content="+5 PROGs + 2 FUGRs",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Scan FTP_PSWD",
                    content="+1 PROG (BNP password variant)",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Scan _FROM_SFTP",
                    content="+2 PROGs (wrapper callers)",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Sanity ZSFTP_ prefix",
                    content="+1 FUGR (ZDMS_SEND_FILE, _TO_SFTP naming)",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 12 — Final inventory (BlockGrid 3 columns + footer note)
    # ---------------------------------------------------------------
    slide12, content12 = prs.add_default_slide(
        title="Final SFTP inventory — Z001",
    )

    # 3-column grid of LEFT_ICON_AND_TITLE cards
    prs.add_block_grid(
        content12,
        BlockGrid(
            left=0,
            top=0,
            width=content12.width,
            height=0,
            columns=3,
            gap=GapSize.MEDIUM,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=True,
            text_size=TextSize.MEDIUM,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="16 PROG reports",
                    content="Direct SXPG callers plus wrapper callers.",
                    icon_category="Documents",
                    icon_name="Document_Checklist_2",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="3 wrapper FUGRs",
                    content="ZMEDICARE, ZERX, ZDMS_SEND_FILE — credential isolation for indirect callers.",
                    icon_category="Processes",
                    icon_name="Gear_Process_1",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="11 SM69 + 5 wrapper FMs",
                    content="The actual mechanism artifacts on the OS side.",
                    icon_category="Processes",
                    icon_name="API_1",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # Footer note as CALLOUT below the grid (auto-positioned near bottom)
    prs.add_block(
        content12,
        Block(
            left=0,
            bottom=0,
            width=content12.width,
            height=0,
            content=(
                "3 SM69 entries are shared by ≥2 ABAP reports — "
                "coordinate cutover for each shared command."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 13 — Scan discipline (BlockProcess, 4 steps)
    # ---------------------------------------------------------------
    slide13, content13 = prs.add_default_slide(
        title="How we made the scans complete",
    )

    prs.add_block_process(
        content13,
        BlockProcess(
            left=0,
            top=0,
            width=content13.width,
            height=int(content13.height * 0.62),
            direction=ProcessDirection.HORIZONTAL,
            color=EPAMColor.Light_Blue,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Step 1",
                    content="One scan at a time per destination.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Step 2",
                    content="Single-keyword over AND-query (timeout-safe).",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Step 3",
                    content="Independent markers — don't rely on naming.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Step 4",
                    content="Sanity scan beyond credential literals.",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # Caption block below the process
    prs.add_block(
        content13,
        Block(
            left=0,
            bottom=0,
            width=content13.width,
            height=0,
            content="All seven scans returned without truncation.",
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Teal,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )


def test_part4():
    prs = EPAMPresentation(
        output_path="presentation_part4.pptx"
    )

    generate_part4(prs)

    prs.save()
    print("Presentation created: presentation_part4.pptx")


if __name__ == "__main__":
    test_part4()
