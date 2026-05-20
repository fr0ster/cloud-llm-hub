from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockMarginPreset,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
)


def generate_part3(prs: EPAMPresentation):
    # ----- Slide 7 — Section divider: Security (Section Header Dark) -----
    prs.add_section_header_slide_dark(
        section_number="02",
        section_title="Security",
        section_description=(
            "Authorization, OS-shell injection, information disclosure — "
            "4 findings, 2 HIGH."
        ),
    )

    # ----- Slide 8 — Security severity overview (Default Slide, Title + Upsubtitle) -----
    slide8, content8 = prs.add_default_slide(
        title="Security: 4 findings",
        upsubtitle="TWO HIGH AROUND OS SHELL",
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
            metric_value="1",
            content="MEDIUM",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Teal,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            metric_value="1",
            content="LOW",
            style=BlockStyle.HERO_METRIC_ON_TOP,
            color=EPAMColor.Light_Gray,
            horizontal_alignment=HorizontalAlignment.CENTER,
        ),
    ]

    prs.add_block_grid(
        content8,
        BlockGrid(
            left=0,
            top=0,
            width=content8.width,
            height=2400000,
            columns=4,
            gap=GapSize.MEDIUM,
            blocks=severity_blocks,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
        ),
        background=Background.LIGHT,
    )

    # ----- Slide 9 — Security findings list (Default Slide, Title only) -----
    slide9, content9 = prs.add_default_slide(
        title="Security — all 4 findings",
    )

    findings = [
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — Missing AUTHORITY-CHECK before SFTP GET",
            content=(
                "No explicit auth check before SXPG_COMMAND_EXECUTE "
                "(SFTP pull path)."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="HIGH — Missing AUTHORITY-CHECK before SFTP PUT",
            content=(
                "Same gap on the push path; relies only on FM no_permission "
                "exception."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="MEDIUM — Shell-injection risk in parameters",
            content=(
                "gv_param built by unescaped CONCATENATE from "
                "zfi_constants-fval."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Teal,
            text_size=TextSize.SMALL,
        ),
        Block(
            left=0, top=0, width=0, height=0,
            title="LOW — Sensitive details leaked via WRITE",
            content=(
                "OPEN DATASET error messages reveal filesystem paths to the "
                "user."
            ),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
        ),
    ]

    prs.add_block_grid(
        content9,
        BlockGrid(
            left=0,
            top=0,
            width=content9.width,
            height=content9.height,
            columns=2,
            gap=GapSize.MEDIUM,
            blocks=findings,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            margin_preset=BlockMarginPreset.REGULAR,
        ),
        background=Background.LIGHT,
    )


def test_part3():
    prs = EPAMPresentation(output_path="presentation_part3.pptx")
    generate_part3(prs)
    prs.save()
    print("Presentation created: presentation_part3.pptx")


if __name__ == "__main__":
    test_part3()
