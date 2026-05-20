from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockProcess,
    BlockMarginPreset,
    BlockImageSize,
    ProcessDirection,
    ChevronProcess,
    ChevronWidth,
    ChevronStep,
    DiagramCanvas,
    ConnectionLineStyle,
    ConnectionConnectorStyle,
    NodeStyle,
    ConceptMap,
    ConceptMapTopic,
    Text,
    Image,
    ImageStyle,
    ImageCrop,
    ImageBorderStyle,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    VerticalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
    CatalogSlide,
    CaseStudy,
)


def generate_part3(prs: EPAMPresentation):
    # ------------------------------------------------------------------
    # Slide 6 — Section divider: "Methods" (Light, number "02")
    # ------------------------------------------------------------------
    prs.add_section_header_slide(
        section_title="Methods",
        section_description=(
            "Stage 2 read every seed and its includes. Stage 2b enumerated "
            "methods openly. One mechanism kept showing up."
        ),
        section_number="03",
    )

    # ------------------------------------------------------------------
    # Slide 7 — Stage 2 verdicts (White + Grey Split, 2/3)
    # Left (white, 2/3) = hero; Right (grey, 1/3) = section title + breakdown
    # ------------------------------------------------------------------
    slide7, left7, right7 = prs.add_white_and_grey_split_slide(
        title="Stage 2 verdicts",
        section_title="By verdict",
        white_width_ratio="2/3",
    )

    # Left: hero metric "8 / 13"
    prs.add_block(
        left7,
        Block(
            left=0,
            top=0,
            width=left7.width,
            height=0,
            metric_value="8 / 13",
            content="seeds confirmed as SFTP callers",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Orange,
        ),
        background=Background.LIGHT,
    )

    # Right: stacked verdict blocks + footnote
    prs.add_block_grid(
        right7,
        BlockGrid(
            left=0,
            top=0,
            width=right7.width,
            height=0,
            columns=1,
            gap=GapSize.SMALL,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="yes",
                    content="8 — confirmed SFTP callers",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="no",
                    content="5 — local file I/O only",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    content="All 13 verdicts source-cited in 02-methods.md.",
                    style=BlockStyle.CALLOUT,
                    color=EPAMColor.Light_Gray,
                    text_size=TextSize.SMALL,
                ),
            ],
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
        ),
        background=Background.LIGHT,
    )

    # ------------------------------------------------------------------
    # Slide 8 — The one underlying mechanism (BlockProcess, 4 steps)
    # ------------------------------------------------------------------
    slide8, area8 = prs.add_default_slide(
        title="SXPG_COMMAND_EXECUTE → SM69 → OS sftp/scp",
        upsubtitle="SAME SHAPE, EVERY TIME",
    )

    prs.add_block_process(
        area8,
        BlockProcess(
            direction=ProcessDirection.HORIZONTAL,
            left=0,
            top=0,
            width=area8.width,
            height=2743200,  # ~3"
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="1. ABAP report",
                    content="Z* report initiates the call from the customer estate.",
                    style=BlockStyle.SOLID_FILL,
                    color=EPAMColor.Light_Blue,
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="2. Read zfi_constants",
                    content="FTP_USER / HOST_KEY / PRIVATE_KEY_PATH / …",
                    style=BlockStyle.SOLID_FILL,
                    color=EPAMColor.Light_Blue,
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="3. SXPG_COMMAND_EXECUTE",
                    content="CALL FUNCTION with the prepared parameter set.",
                    style=BlockStyle.SOLID_FILL,
                    color=EPAMColor.Light_Blue,
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="4. SM69 → OS",
                    content="SM69 entry runs sftp/scp binary to the remote endpoint.",
                    style=BlockStyle.SOLID_FILL,
                    color=EPAMColor.Light_Blue,
                ),
            ],
            gap=GapSize.MEDIUM,
        ),
        background=Background.LIGHT,
    )

    # Caption block under the process
    prs.add_block(
        area8,
        Block(
            left=0,
            top=3200400,  # below the process
            width=area8.width,
            height=0,
            content="Every confirmed SFTP report reduces to this pattern.",
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
        ),
        background=Background.LIGHT,
    )

    # ------------------------------------------------------------------
    # Slide 9 — Two auth shapes (BlockGrid 2 cols, 1 row) + caption
    # ------------------------------------------------------------------
    slide9, area9 = prs.add_default_slide(
        title="Two auth shapes the migration must support",
    )

    prs.add_block_grid(
        area9,
        BlockGrid(
            left=0,
            top=0,
            width=area9.width,
            height=3657600,  # ~4" — leave room for caption
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Key-based (modern)",
                    icon_category="Web",
                    icon_name="Window_Lock",
                    rich_content=[
                        ContentParagraph(text="FTP_USER, FTP_DOMAIN", is_bullet=True),
                        ContentParagraph(
                            text="HOST_KEY, PRIVATE_KEY_PATH, PASSPHRASE",
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            text="Optional: FTP_PORT, FOLDER_PATH, FILE_EXT",
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            text="13 of 14 direct reports + both wrapper FUGRs",
                            is_bullet=True,
                        ),
                    ],
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Password-based (legacy)",
                    icon_category="Checkmarks",
                    icon_name="X_Mark_Box_1",
                    rich_content=[
                        ContentParagraph(
                            text="FTP_USER, FTP_PSWD, FTP_DOMAIN",
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            text="FTP_PORT, HOST_KEY (still)",
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            text="Only ZSFTP_BNP_PARIBAS is pure password-auth",
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            text="Several others read FTP_PSWD defensively",
                            is_bullet=True,
                        ),
                    ],
                ),
            ],
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
        ),
        background=Background.LIGHT,
    )

    # Caption block under the grid
    prs.add_block(
        area9,
        Block(
            left=0,
            top=3840480,  # below the grid (slightly below height=3657600)
            width=area9.width,
            height=0,
            content="Single-auth replacements would break the BNP password path.",
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
        ),
        background=Background.LIGHT,
    )


def test_part3():
    prs = EPAMPresentation(
        output_path="presentation_part3.pptx"
    )

    generate_part3(prs)

    # Save the presentation — validation report printed automatically
    prs.save()
    print("Presentation created: presentation_part3.pptx")


if __name__ == "__main__":
    test_part3()
