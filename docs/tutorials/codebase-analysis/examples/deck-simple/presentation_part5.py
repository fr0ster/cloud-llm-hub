from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockMarginPreset,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    VerticalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
    CaseStudy,
)


def generate_part5(prs: EPAMPresentation):
    # ---------------------------------------------------------------
    # Slide 14 — Section divider: "Analysis" (Section Header Light, "04")
    # ---------------------------------------------------------------
    prs.add_section_header_slide(
        section_title="Analysis",
        section_description=(
            "16 reports cluster into 5 business domains. The migration validation "
            "matrix has to verify each endpoint separately."
        ),
        section_number="04",
    )

    # ---------------------------------------------------------------
    # Slide 15 — Domains overview (BlockGrid 3 cols x 2 rows)
    # 5 domain cards + 1 hero-metric "Total" block
    # ---------------------------------------------------------------
    slide15, content15 = prs.add_default_slide(
        title="Five business domains, eight counter-parties",
    )

    prs.add_block_grid(
        content15,
        BlockGrid(
            left=0,
            top=0,
            width=content15.width,
            height=0,
            columns=3,
            gap=GapSize.MEDIUM,
            style=BlockStyle.LEFT_ICON_AND_TITLE,
            auto_color_rotation=True,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Banking — statement loaders",
                    content=(
                        "BNP, Citi, JPMorgan · 7 reports · both directions · "
                        "MT940 + payments."
                    ),
                    icon_category="Finance",
                    icon_name="Bank",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Healthcare claims",
                    content=(
                        "Caparío, Patientco · 4 reports · both directions · "
                        "EDI 835 / 837."
                    ),
                    icon_category="Life_Sciences_Healthcare",
                    icon_name="Clipboard_Health",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Payroll",
                    content=(
                        "Ceridian · 2 reports · pull only · posting files into FI."
                    ),
                    icon_category="Business",
                    icon_name="Person",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Document management",
                    content=(
                        "Internal DMS · 3 reports · both directions · "
                        "PDF / CSV / attachments."
                    ),
                    icon_category="Documents",
                    icon_name="Folder_Connected",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    title="Healthcare PDF (Medicare)",
                    content=(
                        "Internal · 2 via ZMEDI / ZERX wrappers · both directions · "
                        "Medicare PDFs / CSVs."
                    ),
                    icon_category="Life_Sciences_Healthcare",
                    icon_name="Healthcare_Drugs",
                ),
                Block(
                    left=0, top=0, width=0, height=0,
                    metric_value="16",
                    content="reports total · plus 2 wrapper FUGRs.",
                    style=BlockStyle.HERO_METRIC_ON_TOP,
                    color=EPAMColor.Light_Orange,
                    horizontal_alignment=HorizontalAlignment.CENTER,
                    vertical_alignment=VerticalAlignment.MIDDLE,
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # ---------------------------------------------------------------
    # Slide 16 — Case study: Banking (Wealth Management Micro-Frontends)
    # ---------------------------------------------------------------
    prs.add_case_study(
        CaseStudy.Large_Wealth_Management_Company_Micro_Frontends_Development
    )

    # ---------------------------------------------------------------
    # Slide 17 — Case study: Healthcare claims analytics
    # ---------------------------------------------------------------
    prs.add_case_study(
        CaseStudy.Transforming_Healthcare_Claims_Analytics_with_Data_Pipeline_Modernization
    )

    # ---------------------------------------------------------------
    # Slide 18 — What stays out (the "no" verdicts)
    # Default Slide, Title + Upsubtitle. One block with rich list + caption.
    # ---------------------------------------------------------------
    slide18, content18 = prs.add_default_slide(
        title="Five seeds dropped from migration code scope",
        upsubtitle="NOT SFTP CALLERS",
    )

    # Single block with a rich-content list of the 5 dropped seeds
    prs.add_block(
        content18,
        Block(
            left=0,
            top=0,
            width=content18.width,
            height=0,
            title="Dropped seeds",
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.MEDIUM,
            rich_content=[
                ContentParagraph(
                    runs=[
                        TextRun(text="/VERTEX/SPOT_VAT_OUTPUT_COMPL", bold=True),
                        TextRun(text=" — Vertex tax, local I/O."),
                    ],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="/VERTEX/SPOT_VAT_INPUT_COMPL", bold=True),
                        TextRun(text=" — Vertex tax, local I/O."),
                    ],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="ZEDI_835", bold=True),
                        TextRun(text=" — OPEN DATASET / GUI_UPLOAD only."),
                    ],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="ZEDI_835_JPM", bold=True),
                        TextRun(text=" — same shape, JPMorgan variant."),
                    ],
                    is_bullet=True,
                ),
                ContentParagraph(
                    runs=[
                        TextRun(text="ZFI_BANK_STMT_LOAD", bold=True),
                        TextRun(text=" — local include processing."),
                    ],
                    is_bullet=True,
                ),
            ],
        ),
        background=Background.LIGHT,
    )

    # Caption explaining why they still matter downstream
    prs.add_block(
        content18,
        Block(
            left=0,
            bottom=0,
            width=content18.width,
            height=0,
            content=(
                "Their file paths must still exist after the SFTP layer is replaced — "
                "they consume what SFTP callers land."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )


def test_part5():
    prs = EPAMPresentation(
        output_path="presentation_part5.pptx"
    )

    generate_part5(prs)

    # Save the presentation — validation report printed automatically
    prs.save()
    print("Presentation created: presentation_part5.pptx")


if __name__ == "__main__":
    test_part5()
