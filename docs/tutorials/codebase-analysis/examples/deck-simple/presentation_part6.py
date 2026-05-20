from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockProcess,
    BlockMarginPreset,
    ProcessDirection,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    VerticalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)


def generate_part6(prs: EPAMPresentation):
    # ---------------------------------------------------------------
    # Slide 19 — Section divider: "Result" (Section Header Dark, "05")
    # ---------------------------------------------------------------
    prs.add_section_header_slide_dark(
        section_title="Result",
        section_description=(
            "The answer to the original goal, plus what the next team needs "
            "before they start writing code."
        ),
        section_number="06",
    )

    # ---------------------------------------------------------------
    # Slide 20 — Headline numbers (3 x 2 hero metrics, no icons)
    # ---------------------------------------------------------------
    slide20, content20 = prs.add_default_slide(
        title="Migration scope, in numbers",
    )

    prs.add_block_grid(
        content20,
        BlockGrid(
            left=0,
            top=0,
            width=content20.width,
            height=content20.height,
            columns=3,
            gap=GapSize.MEDIUM,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="18",
                    content="ABAP objects in scope (16 PROG + 2 FUGR core).",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="16",
                    content="business consumer reports.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="8",
                    content="distinct counter-party endpoints.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="11",
                    content="SM69 commands.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="2",
                    content="auth modes to support.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="+46%",
                    content="vs the original seed list.",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 21 — What the new SFTP layer must support (2 x 3 grid with icons)
    # ---------------------------------------------------------------
    slide21, content21 = prs.add_default_slide(
        title="Replacement must support…",
    )

    prs.add_block_grid(
        content21,
        BlockGrid(
            left=0,
            top=0,
            width=content21.width,
            height=content21.height,
            columns=3,
            gap=GapSize.MEDIUM,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Both auth modes",
                    content="Key-based AND password-based (BNP requires both).",
                    icon_category="Web",
                    icon_name="Window_Lock",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Both directions",
                    content="8 pull · 6 push · 2 both.",
                    icon_category="Arrows",
                    icon_name="Arrows_Repeat_1",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="PGP layer",
                    content="ZSFTP_BNP_PARIBAS_WITH_PGP wraps the push.",
                    icon_category="Web",
                    icon_name="Window_Lock",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="11 endpoints",
                    content="Each SM69 binds one bank or provider host.",
                    icon_category="Global",
                    icon_name="Global_Cloud",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="zfi_constants single source",
                    content="All 16+3 read from it — keep or shim.",
                    icon_category="Database",
                    icon_name="Database",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Non-default ports",
                    content="FTP_PORT concatenated as ':port'.",
                    icon_category="Processes",
                    icon_name="API_2",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 22 — Migration priority (BlockProcess, 4 steps)
    # ---------------------------------------------------------------
    slide22, content22 = prs.add_default_slide(
        title="A natural cutover order",
    )

    prs.add_block_process(
        content22,
        BlockProcess(
            left=0,
            top=0,
            width=content22.width,
            height=int(content22.height * 0.62),
            direction=ProcessDirection.HORIZONTAL,
            color=EPAMColor.Light_Blue,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Banking",
                    content="7 reports — MT940 + PGP for BNP.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Healthcare clearinghouses",
                    content="4 reports — EDI 835/837 round-trip.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Payroll",
                    content="2 reports — Ceridian posting → FI.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Internal DMS / eRx",
                    content="5 reports — wrapper-FM integrity.",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content22,
        Block(
            left=0,
            bottom=0,
            width=content22.width,
            height=0,
            content=(
                "Each step has its own validation matrix; wrappers migrate as one unit."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Teal,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 23 — Known unknowns (1 column, 3 stacked blocks with icons)
    # ---------------------------------------------------------------
    slide23, content23 = prs.add_default_slide(
        title="Open questions the migration team must close",
    )

    prs.add_block_grid(
        content23,
        BlockGrid(
            left=0,
            top=0,
            width=content23.width,
            height=0,
            columns=1,
            gap=GapSize.MEDIUM,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="OS-side SM69 script behavior",
                    content=(
                        "11 SM69 entries; behavior is in SAP GUI tx SM69, "
                        "out of scope for ABAP-only analysis. Needs Basis access."
                    ),
                    icon_category="Workshop",
                    icon_name="Repair",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Two reports share the Ceridian command",
                    content=(
                        "Operator preference or refactor leftover? "
                        "Suggest consolidating after business-owner sign-off."
                    ),
                    icon_category="People",
                    icon_name="2_People",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="ZDMS_EXTRACT_DOCS_TO_SFTP has 0 literal callers",
                    content=(
                        "Dynamic call, cross-package caller, or dead code — "
                        "must be resolved during cutover."
                    ),
                    icon_category="Tasks",
                    icon_name="Document_Magnify",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 24 — Completeness confidence (Default Slide, Title + Upsubtitle)
    # 2 columns x 1 row BlockGrid with bullet lists
    # ---------------------------------------------------------------
    slide24, content24 = prs.add_default_slide(
        upsubtitle="CONFIDENCE IN SCOPE",
        title="≈95% in scope · residual risk is hardcoded SFTP without zfi_constants",
    )

    prs.add_block_grid(
        content24,
        BlockGrid(
            left=0,
            top=0,
            width=content24.width,
            height=0,
            columns=2,
            gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Within Z001 (PROG / FUGR / CLAS)",
                    rich_content=[
                        ContentParagraph(
                            runs=[TextRun(text="3 independent credential-bag scans, all complete")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="1 sanity scan beyond credential literals")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="Wrapper FUGRs enumerated, callers identified")],
                            is_bullet=True,
                        ),
                    ],
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Outside Z001",
                    rich_content=[
                        ContentParagraph(
                            runs=[TextRun(text="Other top-level Z* packages: un-scanned")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="Cross-package callers of wrapper FUGRs: open")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="Customer confirmation lifts confidence to ≈99%")],
                            is_bullet=True,
                        ),
                    ],
                ),
            ],
        ),
        background=Background.LIGHT,
    )


def test_part6():
    prs = EPAMPresentation(
        output_path="presentation_part6.pptx"
    )

    generate_part6(prs)

    prs.save()
    print("Presentation created: presentation_part6.pptx")


if __name__ == "__main__":
    test_part6()
