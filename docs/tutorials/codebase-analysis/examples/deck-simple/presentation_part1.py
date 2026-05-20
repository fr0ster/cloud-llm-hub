from simple_deck import EPAMPresentation, Background
from simple_deck import (
    Block,
    BlockGrid,
    BlockStyle,
    BlockProcess,
    BlockMarginPreset,
    BlockImageSize,
    ProcessDirection,
    ChevronProcess,
    ChevronWidth,
    ChevronStep,
    DiagramCanvas,
    ConnectionLineStyle,
    ConnectionConnectorStyle,
    NodeStyle,
    ConceptMap,
    ConceptMapTopic,
    Text,
    Image,
    ImageStyle,
    ImageCrop,
    ImageBorderStyle,
    ContentParagraph,
    TextRun,
    HorizontalAlignment,
    VerticalAlignment,
    TextSize,
    GapSize,
    EPAMColor,
    CatalogSlide,
    CaseStudy,
)
from simple_deck import format_spaced_text


def generate_part1(prs: EPAMPresentation):
    # Slide 1 — Cover (Dark, no image)
    prs.add_cover_slide_dark(
        presentation_title="SFTP Usage Analysis",
        description="Where the ABAP estate talks to SFTP",
        date=format_spaced_text("MAY 2026"),
    )

    # Slide 2 — Contents (Light), max 6 items
    prs.add_contents_slide(
        contents=[
            "Methodology — how user + AI worked",
            "The task — 13 seeds, one question",
            "Methods · Usage map",
            "Analysis — by business domain",
            "Result — migration handoff",
            "Retro",
        ]
    )


def test_part1():
    prs = EPAMPresentation(
        output_path="presentation_part1.pptx"
    )

    generate_part1(prs)

    # Save the presentation — validation report printed automatically
    prs.save()
    print("Presentation created: presentation_part1.pptx")


if __name__ == "__main__":
    test_part1()
