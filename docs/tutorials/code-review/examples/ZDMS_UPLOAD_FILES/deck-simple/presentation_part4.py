from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    HorizontalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)


def generate_part4(prs: EPAMPresentation):
    # ----- Slide 10 — Section divider: Performance (Section Header Dark) -----
    prs.add_section_header_slide_dark(
        section_number="04",
        section_title="Performance",
        section_description=(
            "Wide SELECTs and per-row function calls inside loops — "
            "4 findings, 2 HIGH."
        ),
    )

    # ----- Slide 11 — Performance severity overview (Default Slide, Title + Upsubtitle) -----
    slide11, content11 = prs.add_default_slide(
        title="Performance: 4 findings",
        upsubtitle="LOOP-BOUND FM CALLS",
    )

    severity_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="0",
            content="CRITICAL",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Red,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="2",
            content="HIGH",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Orange,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="2",
            content="MEDIUM",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Teal,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="0",
            content="LOW",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Gray,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
    ]

    prs.add_block_grid(
        content11,
        BlockGrid(
            left=0,
            top=0,
            width=content11.width,
            height=2400000,
            columns=4,
            gap=GapSize.MEDIUM,
            blocks=severity_blocks,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 12 — Performance findings list (Default Slide, Title only) -----
    slide12, content12 = prs.add_default_slide(
        title="Performance — all 4 findings",
    )

    finding_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — FORMAT_MESSAGE called per row",
            content=(
                "Inside LOOP AT pt_data; same message formatter invoked "
                "for every entry."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — ZDMS_UPLOAD_DOCUMENTS called per row",
            content=(
                "Upload FM invoked per row — should use a mass / "
                "table-parameter API."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="MEDIUM — SELECT * on TVARVC",
            content="Wide fetch where only sign / opti / low / high are needed.",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Teal,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="MEDIUM — SELECT * on DMS_DOC_FILES",
            content=(
                "Wide fetch with FOR ALL ENTRIES; only filename is used "
                "downstream."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Teal,
        ),
    ]

    prs.add_block_grid(
        content12,
        BlockGrid(
            left=0,
            top=0,
            width=content12.width,
            height=content12.height,
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=finding_blocks,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
        ),
        background=Background.LIGHT,
    )


def test_part4():
    prs = EPAMPresentation(output_path="presentation_part4.pptx")
    generate_part4(prs)
    prs.save()
    print("Presentation created: presentation_part4.pptx")


if __name__ == "__main__":
    test_part4()
