from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    HorizontalAlignment,
    TextSize,
    GapSize,
    BlockMarginPreset,
    EPAMColor,
)


def generate_part5(prs: EPAMPresentation):
    # ----- Slide 13 — Section divider: Clean Core (Section Header Dark) -----
    prs.add_section_header_slide_dark(
        section_number="05",
        section_title="Clean Core",
        section_description=(
            "S/4HANA Cloud readiness — 6 HIGH findings. "
            "This object will not run on Cloud as-is."
        ),
    )

    # ----- Slide 14 — Clean Core severity overview (Default Slide, Title + Upsubtitle) -----
    slide14, content14 = prs.add_default_slide(
        title="Clean Core: 6 findings, all HIGH",
        upsubtitle="EVERY FINDING BLOCKS CLOUD",
    )

    severity_blocks_14 = [
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
            metric_value="6",
            content="HIGH",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Orange,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="0",
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

    metric_grid_height_14 = 2400000  # ~2.6"
    prs.add_block_grid(
        content14,
        BlockGrid(
            left=0,
            top=0,
            width=content14.width,
            height=metric_grid_height_14,
            columns=4,
            gap=GapSize.MEDIUM,
            blocks=severity_blocks_14,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # Verdict callout below the metric row
    prs.add_block(
        content14,
        Block(
            left=0,
            top=metric_grid_height_14 + 274320,
            width=content14.width,
            height=0,
            content="Verdict: rewrite, not patch — if S/4HANA Cloud is on the roadmap.",
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.LARGE,
            horizontal_alignment=HorizontalAlignment.LEFT,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 15 — Clean Core findings list (Default Slide, Title only) -----
    slide15, content15 = prs.add_default_slide(
        title="Clean Core — all 6 findings",
    )

    # 6 HIGH findings — all use the HIGH accent color (Light_Orange) per design convention.
    finding_blocks_15 = [
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — SXPG_COMMAND_EXECUTE (SFTP GET)",
            content="OS-shell access via SM69 — not allowed in Cloud.",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — SXPG_COMMAND_EXECUTE (SFTP PUT)",
            content="Same shell-access blocker on the push path.",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — OPEN/READ/TRANSFER DATASET (app-server FS)",
            content="Direct AL11-style file I/O — disallowed in Cloud.",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — DELETE DATASET (post-process cleanup)",
            content="App-server file deletion — disallowed in Cloud.",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — DELETE DATASET (error path)",
            content="Second AL11 deletion site, same blocker.",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — Direct SELECT on TVARVC",
            content="Standard config table read without released API.",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
        ),
    ]

    prs.add_block_grid(
        content15,
        BlockGrid(
            left=0,
            top=0,
            width=content15.width,
            height=content15.height,
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=finding_blocks_15,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )


def test_part5():
    prs = EPAMPresentation(output_path="presentation_part5.pptx")
    generate_part5(prs)
    prs.save()
    print("Presentation created: presentation_part5.pptx")


if __name__ == "__main__":
    test_part5()
