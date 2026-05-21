"""Part 1 — Cover and Contents."""

from simple_deck import EPAMPresentation
from simple_deck import format_spaced_text


def generate_part1(prs: EPAMPresentation):
    prs.add_cover_slide_dark(
        presentation_title="AI-Assisted Code Docs",
        description="Four-phase pipeline · ABAP report walkthrough",
        date=format_spaced_text("MAY 2026"),
    )

    prs.add_contents_slide(
        contents=[
            "The pipeline",
            "Phases 1-3 · documents only",
            "Phase 3 · read first, deps next",
            "The target",
            "The result",
            "Outcome",
        ]
    )


def test_part1():
    prs = EPAMPresentation(output_path="presentation_part1.pptx")
    generate_part1(prs)
    prs.save()
    print("Presentation created: presentation_part1.pptx")


if __name__ == "__main__":
    test_part1()
