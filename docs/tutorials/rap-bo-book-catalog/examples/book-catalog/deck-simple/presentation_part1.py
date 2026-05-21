"""Part 1 — Cover and Contents."""

from simple_deck import EPAMPresentation
from simple_deck import format_spaced_text


def generate_part1(prs: EPAMPresentation):
    prs.add_cover_slide_dark(
        presentation_title="AI-Assisted RAP BO",
        description="Four-phase pipeline · RAP app with AI",
        date=format_spaced_text("MAY 2026"),
    )

    prs.add_contents_slide(
        contents=[
            "The pipeline · phases · loop",
            "Skill catalog + one example",
            "Artifacts across phases",
            "What got built · 72 objects",
            "What goes wrong",
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
