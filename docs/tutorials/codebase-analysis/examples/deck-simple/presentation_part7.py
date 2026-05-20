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


def generate_part7(prs: EPAMPresentation):
    # ---------------------------------------------------------------
    # Slide 25 — Section divider: "Retro" (Section Header Light, "06")
    # ---------------------------------------------------------------
    prs.add_section_header_slide(
        section_title="Retro",
        section_description=(
            "What the run actually cost, what went wrong, and what the next "
            "analysis run inherits."
        ),
        section_number="07",
    )

    # ---------------------------------------------------------------
    # Slide 26 — Wall-clock + tokens (hero metrics, 3 x 2 grid)
    # ---------------------------------------------------------------
    slide26, content26 = prs.add_default_slide(
        title="Run economics",
    )

    prs.add_block_grid(
        content26,
        BlockGrid(
            left=0,
            top=0,
            width=content26.width,
            height=content26.height,
            columns=3,
            gap=GapSize.MEDIUM,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="~2 h",
                    content="total wall-clock",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="1.05 M",
                    content="executor-side tokens (gpt-5.2 + embedder)",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="264",
                    content="model requests across the run",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="~$66",
                    content="controller-side share (Claude Opus 4.7, sFTP portion)",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="7",
                    content="independent SearchSource scans",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="4-12 h",
                    content="manual UI estimate for comparable analysis",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 27 — What went well (2 x 2 BlockGrid, LEFT_ICON_AND_TITLE)
    # ---------------------------------------------------------------
    slide27, content27 = prs.add_default_slide(
        title="What held up",
    )

    prs.add_block_grid(
        content27,
        BlockGrid(
            left=0,
            top=0,
            width=content27.width,
            height=content27.height,
            columns=2,
            gap=GapSize.MEDIUM,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=True,
            text_size=TextSize.MEDIUM,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Per-stage isolation",
                    content="One stage per session; artifact on disk before the next.",
                    icon_category="Processes",
                    icon_name="Gear_Process_1",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Raw-SSE evidence",
                    content="Every claim reproducible from curl/*.sse.",
                    icon_category="Documents",
                    icon_name="Document_Checklist_2",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Lessons captured in-flight",
                    content="6 skills + 1 decision + 1 tool-usage skill written during the run.",
                    icon_category="Education",
                    icon_name="Books",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Iterative scope expansion",
                    content="Three independent scans, each justified by the prior finding.",
                    icon_category="Arrows",
                    icon_name="Arrows_Repeat_1",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 28 — What we'd do differently (2 x 3 BlockGrid)
    # ---------------------------------------------------------------
    slide28, content28 = prs.add_default_slide(
        title="Lessons for the next run",
    )

    prs.add_block_grid(
        content28,
        BlockGrid(
            left=0,
            top=0,
            width=content28.width,
            height=content28.height,
            columns=2,
            gap=GapSize.SMALL,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="English prompts only",
                    content="First UA batch wasted ~500k tokens.",
                    icon_category="Education",
                    icon_name="Books",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Spell out every SearchSource param",
                    content="Don't rely on planning-LLM defaults.",
                    icon_category="Tasks",
                    icon_name="Document_Checklist_3",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="One scan at a time per destination",
                    content="Stability over wall-clock; 4 parallel scans crashed the backend.",
                    icon_category="Calendars_Timing",
                    icon_name="Clock_24h",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Never mix SearchObject + SearchSource",
                    content="In one prompt the model picks the wrong one.",
                    icon_category="Checkmarks",
                    icon_name="X_Mark_Circle_1",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Assert tool availability positively",
                    content="Negative assertions leak tool names and trigger amnesia.",
                    icon_category="Checkmarks",
                    icon_name="Checkmark_Circle_1",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Add 'exactly ONCE' guards",
                    content="Stops 50x GetIncludesList loops.",
                    icon_category="Calendars_Timing",
                    icon_name="Clock_24h",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 29 — Methodology validation (BlockProcess, 3 steps)
    # ---------------------------------------------------------------
    slide29, content29 = prs.add_default_slide(
        title="Three refinements to fold back",
        upsubtitle="THE 5-STAGE TUTORIAL HELD UP",
    )

    prs.add_block_process(
        content29,
        BlockProcess(
            left=0,
            top=0,
            width=content29.width,
            height=int(content29.height * 0.7),
            direction=ProcessDirection.HORIZONTAL,
            color=EPAMColor.Light_Blue,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Stage 2b",
                    content="Open-ended enumeration is necessary — it catches wrapper FMs.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Stage 3",
                    content="Needs >=2 independent markers — password-only would be missed.",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Late sanity scan",
                    content="Beyond credential literals — caught the ZDMS_SEND_FILE wrapper.",
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 30 — Thank you / next steps (Default Slide Dark with subtitle)
    # ---------------------------------------------------------------
    # The outline asks for a short bullet list in the subtitle area, but the
    # subtitle placeholder doesn't render rich bullets cleanly — put the title,
    # use the upsubtitle for "Next steps", and place the bullets as a content
    # block in the content area below.
    slide30, content30 = prs.add_default_slide_dark(
        title="Thank you",
        upsubtitle="NEXT STEPS",
    )

    prs.add_block(
        content30,
        Block(
            left=0,
            top=0,
            width=content30.width,
            height=0,
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Hand artifacts (02-05 + extracts) to migration team")],
                    is_bullet=True,
                    space_after_pt=6,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Basis input on SM69 OS-side scripts")],
                    is_bullet=True,
                    space_after_pt=6,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Confirm Z001-only scope or run scans on other Z* roots")],
                    is_bullet=True,
                    space_after_pt=6,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="Contact: ", bold=True),
                        TextRun(text="codebase-analysis tutorial owner (cloud-llm-hub repo)"),
                    ],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.SIMPLE,
            text_size=TextSize.MEDIUM,
            font_color=EPAMColor.White,
        ),
        background=Background.DARK,
    )


def test_part7():
    prs = EPAMPresentation(
        output_path="presentation_part7.pptx"
    )

    generate_part7(prs)

    prs.save()
    print("Presentation created: presentation_part7.pptx")


if __name__ == "__main__":
    test_part7()
