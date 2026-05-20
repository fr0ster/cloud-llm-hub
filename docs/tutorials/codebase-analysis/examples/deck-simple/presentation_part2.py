from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockMarginPreset,
    ContentParagraph,
    TextRun,
    TextSize,
    GapSize,
    EPAMColor,
)


def generate_part2(prs: EPAMPresentation):
    # ---- Slide 3 — Section divider: "The Task" ----
    prs.add_section_header_slide_dark(
        section_title="The Task",
        section_description=(
            "13 stakeholder-listed reports. One question: how does each one use SFTP? "
            "Output supports migration handoff — we do NOT design the replacement."
        ),
        section_number="01",
    )

    # ---- Slide 4 — Goal and scope ----
    slide4, area4 = prs.add_default_slide(title="Goal and scope")

    prs.add_block_grid(
        area4,
        BlockGrid(
            left=0,
            top=0,
            width=area4.width,
            height=0,
            columns=3,
            gap=GapSize.MEDIUM,
            style=BlockStyle.TOP_ICON_AND_TITLE,
            text_size=TextSize.SMALL,
            auto_color_rotation=True,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Goal",
                    icon_category="Goals",
                    icon_name="Target",
                    rich_content=[
                        ContentParagraph(
                            runs=[TextRun(text="SFTP verdict per seed (yes/no/unclear/not-found)")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="For each yes: methods, direction, payload")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="Blind spots called out explicitly")],
                            is_bullet=True,
                        ),
                    ],
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="In scope",
                    icon_category="Tasks",
                    icon_name="Document_Checklist_3",
                    rich_content=[
                        ContentParagraph(
                            runs=[TextRun(text="Z* and /VERTEX/* in DS4_CLH")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="13 seed objects")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="Where-used traversal from confirmed SFTP")],
                            is_bullet=True,
                        ),
                    ],
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Out of scope",
                    icon_category="Checkmarks",
                    icon_name="X_Mark_Circle_1",
                    rich_content=[
                        ContentParagraph(
                            runs=[TextRun(text="Replacement design / target API selection")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="IDoc, OData, EDI (unless they explain a usage site)")],
                            is_bullet=True,
                        ),
                        ContentParagraph(
                            runs=[TextRun(text="SAP standard namespace")],
                            is_bullet=True,
                        ),
                    ],
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---- Slide 5 — Run setup ----
    slide5, area5 = prs.add_default_slide(
        title="13 seeds. One destination. SmartAgent over MCP.",
        upsubtitle="HOW THE RUN WAS WIRED",
    )

    # Left half: hero metric block "13"
    half_w = (area5.width - 274320) // 2  # subtract gap
    prs.add_block(
        area5,
        Block(
            left=0,
            top=0,
            width=half_w,
            height=area5.height,
            metric_value="13",
            content="stakeholder-listed seeds (corrected mid-run)",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Orange,
        ),
        background=Background.LIGHT,
    )

    # Right half: two stacked blocks
    right_left = half_w + 274320
    right_w = area5.width - right_left
    gap = 182880
    sub_h = (area5.height - gap) // 2

    prs.add_block(
        area5,
        Block(
            left=right_left,
            top=0,
            width=right_w,
            height=sub_h,
            title="Transport",
            rich_content=[
                ContentParagraph(
                    runs=[
                        TextRun(text="/v1/chat/completions", bold=True),
                        TextRun(text=" via local MCP proxy"),
                    ],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="Header "),
                        TextRun(text="x-sap-destination: DS4_CLH", bold=True),
                    ],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        area5,
        Block(
            left=right_left,
            top=sub_h + gap,
            width=right_w,
            height=sub_h,
            title="Provider",
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="OpenAI gpt-5.2 / gpt-5.5-pro on ai-applications subaccount")],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[TextRun(text="Anthropic not available here")],
                    is_bullet=True,
                ),
            ],
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Teal,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )


def test_part2():
    prs = EPAMPresentation(
        output_path="presentation_part2.pptx"
    )

    generate_part2(prs)

    prs.save()
    print("Presentation created: presentation_part2.pptx")


if __name__ == "__main__":
    test_part2()
