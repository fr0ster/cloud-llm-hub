from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    Text,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    VerticalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)
from simple_deck import format_spaced_text


def generate_part1(prs: EPAMPresentation):
    # ----- Slide 1 — Cover (Cover Dark, no image) -----
    prs.add_cover_slide_dark(
        presentation_title="ZDMS_UPLOAD_FILES",
        description="Security, performance, Clean Core, maintainability",
        date=format_spaced_text("MAY 2026"),
    )

    # ----- Slide 2 — Contents (Contents Light) -----
    prs.add_contents_slide(
        contents=[
            "Target & scope",
            "Security findings",
            "Performance findings",
            "Clean Core findings",
            "Maintainability findings",
            "Summary, priorities & retro",
        ]
    )

    # ----- Slide 3 — Executive snapshot (Default Slide, Title + Upsubtitle) -----
    slide3, content3 = prs.add_default_slide(
        title="30 findings across 4 axes",
        upsubtitle="ONE REPORT · ONE AI PASS",
    )

    # Severity row: HERO_METRIC_ON_TOP × 5 (CRITICAL/HIGH/MEDIUM/LOW + wall-clock)
    # Per design.md: severity accent colors fixed; reserve Light_Red even at 0.
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
            metric_value="10",
            content="HIGH",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Orange,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="3",
            content="MEDIUM",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Teal,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="17",
            content="LOW",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Gray,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="6 min",
            content="Wall-clock for full 4-axis review",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Blue,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
    ]

    # The HERO_METRIC row occupies roughly the top half; the callout sits under it.
    metric_grid_height = 2400000  # ~2.6", leaves room for footnote callout below
    prs.add_block_grid(
        content3,
        BlockGrid(
            left=0,
            top=0,
            width=content3.width,
            height=metric_grid_height,
            columns=5,
            gap=GapSize.MEDIUM,
            blocks=severity_blocks,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # Footnote-style callout underneath the metrics
    prs.add_block(
        content3,
        Block(
            left=0,
            top=metric_grid_height + 274320,  # small gap below grid
            width=content3.width,
            height=0,
            content="Comparable senior-engineer manual review: 4–8 hours.",
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.MEDIUM,
            horizontal_alignment=HorizontalAlignment.LEFT,
        ),
        background=Background.LIGHT,
    )


def test_part1():
    prs = EPAMPresentation(output_path="presentation_part1.pptx")
    generate_part1(prs)
    prs.save()
    print("Presentation created: presentation_part1.pptx")


if __name__ == "__main__":
    test_part1()
