from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockProcess,
    BlockStyle,
    BlockMarginPreset,
    ContentParagraph,
    ProcessDirection,
    TextRun,
    TextSize,
    GapSize,
    HorizontalAlignment,
    EPAMColor,
)


def generate_part2(prs: EPAMPresentation):
    # ============================================================
    # SECTION 01 — Methodology
    # ============================================================
    prs.add_section_header_slide_dark(
        section_number="01",
        section_title="Methodology",
        section_description=(
            "How user and AI agreed on the question, designed the scan "
            "pipeline together, executed it stage by stage, and verified."
        ),
    )

    # ---- The method — 4 stages ----
    slide_m1, content_m1 = prs.add_default_slide(
        title="The method — four stages, in order",
        upsubtitle="FOUR STAGES, IN ORDER",
    )

    method_blocks = [
        Block(left=0, top=0, width=0, height=0,
            title="1. Formalize the task",
            content=("Plain-language goal + measurable check. "
                     "Stops us from answering the wrong question."),
            style=BlockStyle.TOP_ICON_AND_TITLE, color=EPAMColor.Light_Blue,
            icon_category="Goals", icon_name="Target", text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="2. Design the process",
            content=("Stage list for THIS task — per-stage artifact, "
                     "per-stage evaluation. Stages are not pre-baked."),
            style=BlockStyle.TOP_ICON_AND_TITLE, color=EPAMColor.Light_Blue,
            icon_category="Structures_Architectures", icon_name="Structure_1",
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="3. Execute stages",
            content=("Each stage produces its artifact. Refine the skill "
                     "at every checkpoint, never as a separate pass."),
            style=BlockStyle.TOP_ICON_AND_TITLE, color=EPAMColor.Light_Blue,
            icon_category="Processes", icon_name="Gear_Process_1",
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="4. Verify the goal",
            content=("Yes → done. No → goal-check names the earlier stage "
                     "to return to, based on what evidence was missing."),
            style=BlockStyle.TOP_ICON_AND_TITLE, color=EPAMColor.Light_Blue,
            icon_category="Checkmarks", icon_name="Checkmark_Circle_1",
            text_size=TextSize.SMALL),
    ]

    prs.add_block_process(
        content_m1,
        BlockProcess(
            direction=ProcessDirection.HORIZONTAL,
            left=0, top=0, width=content_m1.width, height=3200000,
            blocks=method_blocks, gap=GapSize.MEDIUM,
            arrow_color=EPAMColor.Light_Gray,
        ),
        background=Background.LIGHT,
    )
    prs.add_block(
        content_m1,
        Block(
            left=0, top=3500000, width=content_m1.width, height=0,
            content=(
                "Iteration is normal — which earlier stage to return to is "
                "decided by the failing goal-check, not by a pre-baked rule."
            ),
            style=BlockStyle.CALLOUT, color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
        ),
        background=Background.LIGHT,
    )

    # ---- Pair-work as badminton ----
    slide_m2, content_m2 = prs.add_default_slide(
        title="Pair-work as badminton",
        upsubtitle="USER SERVES, AI RETURNS",
    )

    badminton_blocks = [
        Block(left=0, top=0, width=0, height=0,
            title="User serves",
            content=("Plain-language task description. The user names the "
                     "stage; the AI never takes the lead role."),
            style=BlockStyle.LEFT_ICON_AND_TITLE, color=EPAMColor.Light_Blue,
            icon_category="People", icon_name="Person_Suit",
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="AI returns",
            content=("Formalizes, drafts, calls tools, proposes. Each "
                     "return is small enough to review before the next exchange."),
            style=BlockStyle.LEFT_ICON_AND_TITLE, color=EPAMColor.Light_Teal,
            icon_category="AI_VR_Bot", icon_name="Android",
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="User reviews",
            content=("Keeps what holds, rejects what does not, asks for a "
                     "correction. Reader judges, AI drafts. Neither side defers."),
            style=BlockStyle.LEFT_ICON_AND_TITLE, color=EPAMColor.Light_Purple,
            icon_category="Checkmarks", icon_name="Checkmark_Circle_1",
            text_size=TextSize.SMALL),
    ]

    prs.add_block_grid(
        content_m2,
        BlockGrid(
            left=0, top=0, width=content_m2.width, height=content_m2.height,
            columns=1, gap=GapSize.SMALL, blocks=badminton_blocks,
            style=BlockStyle.LEFT_ICON_AND_TITLE, auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ---- How the method mapped to THIS analysis ----
    slide_m3, content_m3 = prs.add_default_slide(
        title="How we ran this analysis",
        upsubtitle="THE FOUR STAGES, MAPPED",
    )

    mapping_blocks = [
        Block(left=0, top=0, width=0, height=0,
            title="Formalize",
            content=("User: 'For 13 seeds, does each call SFTP?' Together: "
                     "verdict per seed, methods/direction/payload, blind spots, "
                     "Z*/VERTEX/* scope, NO replacement design."),
            style=BlockStyle.SOLID_FILL, color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="Design",
            content=("Stage 2: ReadProgram each seed → Stage 2b: open-ended "
                     "method enumeration → Stage 3: independent-marker scans "
                     "→ late sanity scan beyond credential literals."),
            style=BlockStyle.SOLID_FILL, color=EPAMColor.Light_Teal,
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="Execute",
            content=("Per-stage artifact on disk before next stage: "
                     "02-methods.md → 02b-methods-deep.md → 02c-code-extracts.md "
                     "→ 03-usage-map.md → 04-analysis.md → 05-result.md."),
            style=BlockStyle.SOLID_FILL, color=EPAMColor.Light_Purple,
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="Verify",
            content=("13 seeds → 19 confirmed objects · 5 domains · 11 SM69 "
                     "endpoints · per-finding citations. Goal met. Iteration: "
                     "scope grew via 3 independent scans + 1 sanity scan."),
            style=BlockStyle.SOLID_FILL, color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL),
    ]

    prs.add_block_grid(
        content_m3,
        BlockGrid(
            left=0, top=0, width=content_m3.width, height=content_m3.height,
            columns=2, gap=GapSize.MEDIUM, blocks=mapping_blocks,
            style=BlockStyle.SOLID_FILL, auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ---- Discipline that kept the run honest ----
    slide_m4, content_m4 = prs.add_default_slide(
        title="What kept the run honest",
        upsubtitle="THREE DISCIPLINES IN PROMPTS",
    )

    discipline_blocks = [
        Block(left=0, top=0, width=0, height=0,
            title="Per-stage isolation",
            content=("One stage per session. Artifact on disk before next stage. "
                     "Stops context drift; each handoff is reviewable."),
            style=BlockStyle.LEFT_ICON_AND_TITLE, color=EPAMColor.Light_Blue,
            icon_category="Processes", icon_name="Gear_Process_2",
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="Raw-SSE evidence",
            content=("Every claim reproducible from curl/*.sse. Reader can "
                     "re-derive the deck from raw traces — no agent authority."),
            style=BlockStyle.LEFT_ICON_AND_TITLE, color=EPAMColor.Light_Teal,
            icon_category="Documents", icon_name="Document_Layout",
            text_size=TextSize.SMALL),
        Block(left=0, top=0, width=0, height=0,
            title="Sequential SearchSource",
            content=("Heavy ABAP scans run sequentially per destination — "
                     "parallel scans crashed the backend on earlier runs."),
            style=BlockStyle.LEFT_ICON_AND_TITLE, color=EPAMColor.Light_Purple,
            icon_category="Checkmarks", icon_name="Checkmark_Circle_1",
            text_size=TextSize.SMALL),
    ]

    prs.add_block_grid(
        content_m4,
        BlockGrid(
            left=0, top=0, width=content_m4.width, height=content_m4.height,
            columns=1, gap=GapSize.SMALL, blocks=discipline_blocks,
            style=BlockStyle.LEFT_ICON_AND_TITLE, auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # SECTION 02 — The Task (was 01)
    # ============================================================
    prs.add_section_header_slide_dark(
        section_title="The Task",
        section_description=(
            "13 stakeholder-listed reports. One question: how does each one use SFTP? "
            "Output supports migration handoff — we do NOT design the replacement."
        ),
        section_number="02",
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
