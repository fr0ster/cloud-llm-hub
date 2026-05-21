from simple_deck import EPAMPresentation

from presentation_part1 import generate_part1
from presentation_part3 import generate_part3


prs = EPAMPresentation(
    output_path="../report.simple-deck.pptx",
)

generate_part1(prs)
generate_part3(prs)

prs.save()
print("Presentation created: ../report.simple-deck.pptx")
