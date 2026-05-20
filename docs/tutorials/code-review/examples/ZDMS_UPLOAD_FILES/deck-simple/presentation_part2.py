"""Part 2 — Methodology (Section 01) + Target (Section 02).

Methodology comes first, as a dedicated section, before any work-specific
content. Pulls from AI_PAIR_PROGRAMMING_PRINCIPLES.md and the run's
01-target.md + RETRO.md.
"""

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
    # ============================================================
    # SECTION 01 — Methodology
    # ============================================================
    prs.add_section_header_slide_dark(
        section_number="01",
        section_title="Methodology",
        section_description=(
            "How the user and the AI agreed on what to do, designed "
            "the process, executed it together, and verified the result."
        ),
    )

    # ---- Slide: Method — 4 stages ----
    slide_m1, content_m1 = prs.add_default_slide(
        title="The method — four stages, in order",
        upsubtitle="FOUR STAGES, IN ORDER",
    )

    method_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="1. Formalize the task",
            content=(
                "Plain-language goal + how we'll measure it. "
                "Stops us from answering the wrong question."
            ),
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Goals",
            icon_name="Target",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="2. Design the process",
            content=(
                "Stage list for THIS task — per-stage artifact, "
                "per-stage evaluation. Stages are not pre-baked."
            ),
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Structures_Architectures",
            icon_name="Structure_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="3. Execute stages",
            content=(
                "Each stage produces its artifact. Refine the skill or "
                "the process at every checkpoint, never as a separate pass."
            ),
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Processes",
            icon_name="Gear_Process_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="4. Verify the goal",
            content=(
                "Yes → done. No → goal-check names the earlier stage to "
                "return to, based on what evidence was missing."
            ),
            style=BlockStyle.TOP_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="Checkmarks",
            icon_name="Checkmark_Circle_1",
            text_size=TextSize.SMALL,
        ),
    ]

    prs.add_block_process(
        content_m1,
        BlockProcess(
            direction=ProcessDirection.HORIZONTAL,
            left=0,
            top=0,
            width=content_m1.width,
            height=3200000,
            blocks=method_blocks,
            gap=GapSize.MEDIUM,
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
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
        ),
        background=Background.LIGHT,
    )

    # ---- Slide: Pair-work — badminton ----
    slide_m2, content_m2 = prs.add_default_slide(
        title="Pair-work as badminton",
        upsubtitle="USER SERVES, AI RETURNS",
    )

    badminton_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="User serves",
            content=(
                "Plain-language task description. The user names the "
                "stage; the AI never takes the lead role."
            ),
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Blue,
            icon_category="People",
            icon_name="Person_Suit",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="AI returns",
            content=(
                "Formalizes, drafts, calls tools, proposes. Each return "
                "is small enough to review before the next exchange."
            ),
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Teal,
            icon_category="AI_VR_Bot",
            icon_name="Android",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="User reviews",
            content=(
                "Keeps what holds, rejects what does not, asks for a "
                "correction. Reader judges, AI drafts. Neither side defers."
            ),
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Purple,
            icon_category="Checkmarks",
            icon_name="Checkmark_Circle_1",
            text_size=TextSize.SMALL,
        ),
    ]

    prs.add_block_grid(
        content_m2,
        BlockGrid(
            left=0,
            top=0,
            width=content_m2.width,
            height=content_m2.height,
            columns=1,
            gap=GapSize.SMALL,
            blocks=badminton_blocks,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ---- Slide: How the method maps to THIS review ----
    slide_m3, content_m3 = prs.add_default_slide(
        title="How we ran this review",
        upsubtitle="THE FOUR STAGES, MAPPED",
    )

    mapping_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="Formalize",
            content=(
                "User: 'Review ZDMS_UPLOAD_FILES.' Together: scope (the "
                "program + every include), severity scale, 4 review axes."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Design",
            content=(
                "Pipeline: ReadProgram + GetIncludesList + GetInclude → "
                "4 parallel SmartAgent calls → aggregate per ### headings."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Teal,
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Execute",
            content=(
                "Each stage handed off only after its artifact landed: "
                "01-target.md → 02-security.md / 03-performance.md / "
                "04-cleancore.md / 05-maintainability.md → 06-summary.md."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Purple,
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Verify",
            content=(
                "30 findings · severity histogram · per-finding location "
                "cited · verdict. Goal-check passed; no return to earlier stage."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
        ),
    ]

    prs.add_block_grid(
        content_m3,
        BlockGrid(
            left=0,
            top=0,
            width=content_m3.width,
            height=content_m3.height,
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=mapping_blocks,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ---- Slide: Discipline that kept the run honest ----
    slide_m4, content_m4 = prs.add_default_slide(
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
            icon_name="Diagram_1",
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="Read-only parallelism",
            content=(
                "Four SmartAgent calls in parallel are safe ONLY because "
                "tools are read-only. SearchSource would force sequential."
            ),
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            color=EPAMColor.Light_Purple,
            icon_category="Processes",
            icon_name="Gear_Process_2",
            text_size=TextSize.SMALL,
        ),
    ]

    prs.add_block_grid(
        content_m4,
        BlockGrid(
            left=0,
            top=0,
            width=content_m4.width,
            height=content_m4.height,
            columns=1,
            gap=GapSize.SMALL,
            blocks=discipline_blocks,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # SECTION 02 — Target
    # ============================================================
    prs.add_section_header_slide_dark(
        section_number="02",
        section_title="Target",
        section_description=(
            "Legacy ABAP report ZDMS_UPLOAD_FILES — SFTP file transfer via OS "
            "shell commands. One program, every include in scope."
        ),
    )

    slide_t1, content_t1 = prs.add_default_slide(
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
        content_t1,
        BlockGrid(
            left=0,
            top=0,
            width=content_t1.width,
            height=content_t1.height,
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=review_blocks,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=False,
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
