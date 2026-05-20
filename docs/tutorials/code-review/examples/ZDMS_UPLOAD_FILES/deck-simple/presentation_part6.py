from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockMarginPreset,
    HorizontalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)


# Helper: build a compact LOW-finding card.
def _low_finding(title: str, content: str) -> Block:
    return Block(
        left=0, top=0, width=0, height=0,
        title=title,
        content=content,
        style=BlockStyle.SOLID_FILL,
        color=EPAMColor.Light_Gray,
        text_size=TextSize.EXTRA_SMALL,
        margin_preset=BlockMarginPreset.NARROW,
    )


def generate_part6(prs: EPAMPresentation):
    # ----- Slide 16 — Section divider: Maintainability (Section Header Dark) -----
    prs.add_section_header_slide_dark(
        section_number="06",
        section_title="Maintainability",
        section_description=(
            "Style, modern-ABAP and dead-code findings — 16 LOW. "
            "No blockers, steady tech-debt."
        ),
    )

    # ----- Slide 17 — Maintainability severity overview (Default Slide, Title + Upsubtitle) -----
    slide17, content17 = prs.add_default_slide(
        title="Maintainability: 16 findings",
        upsubtitle="ALL LOW · CLEANUP, NO URGENCY",
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
            metric_value="0",
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
            metric_value="16",
            content="LOW",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Gray,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
    ]

    prs.add_block_grid(
        content17,
        BlockGrid(
            left=0,
            top=0,
            width=content17.width,
            height=2400000,
            columns=4,
            gap=GapSize.MEDIUM,
            blocks=severity_blocks,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 18 — Maintainability findings 1/2 (Default Slide, Title only) -----
    slide18, content18 = prs.add_default_slide(
        title="Maintainability — findings 1–8",
    )

    findings_1_8 = [
        _low_finding(
            "LOW — Obsolete CONCATENATE for path build",
            "Use string templates instead of CONCATENATE.",
        ),
        _low_finding(
            "LOW — Magic value for log-color param",
            "Raw '6'/'4'/'3' literals passed around.",
        ),
        _low_finding(
            "LOW — Magic literals in FORMAT COLOR CASE",
            "Same color codes hard-coded again.",
        ),
        _low_finding(
            "LOW — WITH HEADER LINE (lt_return #1)",
            "Obsolete table-with-header declaration.",
        ),
        _low_finding(
            "LOW — WITH HEADER LINE (lt_return #2)",
            "Second instance of the same pattern.",
        ),
        _low_finding(
            "LOW — Commented-out code left in place",
            "Stray *lv_doc declaration above active one.",
        ),
        _low_finding(
            "LOW — SPLIT for filename parsing",
            "Older style; consider FIND REGEX.",
        ),
        _low_finding(
            "LOW — Dead variable lv_userid",
            "Declared, cleared, never sourced.",
        ),
    ]

    prs.add_block_grid(
        content18,
        BlockGrid(
            left=0,
            top=0,
            width=content18.width,
            height=content18.height,
            columns=4,
            gap=GapSize.SMALL,
            blocks=findings_1_8,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            margin_preset=BlockMarginPreset.NARROW,
            text_size=TextSize.EXTRA_SMALL,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 19 — Maintainability findings 2/2 (Default Slide, Title only) -----
    slide19, content19 = prs.add_default_slide(
        title="Maintainability — findings 9–16",
    )

    findings_9_16 = [
        _low_finding(
            "LOW — Mixed inline vs top DATA in same FORM",
            "Inconsistent declaration style.",
        ),
        _low_finding(
            "LOW — Hard-coded 'INVALID PATIENT ID'",
            "Should use message class.",
        ),
        _low_finding(
            "LOW — CONCATENATE for message build",
            "Replace with string template.",
        ),
        _low_finding(
            "LOW — Magic constant 'AU1' (document type)",
            "Extract to named constant.",
        ),
        _low_finding(
            "LOW — Commented-out ENDIF left behind",
            "Control-flow noise.",
        ),
        _low_finding(
            "LOW — Hard-coded allowed-characters string",
            "Opaque validation set.",
        ),
        _low_finding(
            "LOW — CONCATENATE for path with '\\' separator",
            "Magic separator + obsolete style.",
        ),
        _low_finding(
            "LOW — Untyped FORM parameters in f_fill_log",
            "Implicit ANY typing.",
        ),
    ]

    prs.add_block_grid(
        content19,
        BlockGrid(
            left=0,
            top=0,
            width=content19.width,
            height=content19.height,
            columns=4,
            gap=GapSize.SMALL,
            blocks=findings_9_16,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            margin_preset=BlockMarginPreset.NARROW,
            text_size=TextSize.EXTRA_SMALL,
        ),
        background=Background.LIGHT,
    )


def test_part6():
    prs = EPAMPresentation(output_path="presentation_part6.pptx")
    generate_part6(prs)
    prs.save()
    print("Presentation created: presentation_part6.pptx")


if __name__ == "__main__":
    test_part6()
