from simple_deck import EPAMPresentation

from presentation_part1 import generate_part1
from presentation_part2 import generate_part2
from presentation_part3 import generate_part3
from presentation_part4 import generate_part4
from presentation_part5 import generate_part5
from presentation_part6 import generate_part6
from presentation_part7 import generate_part7


prs = EPAMPresentation(
    output_path="../report.simple-deck.pptx",
)

generate_part1(prs)
generate_part2(prs)
generate_part3(prs)
generate_part4(prs)
generate_part5(prs)
generate_part6(prs)
generate_part7(prs)

prs.save()
print("Presentation created: ../report.simple-deck.pptx")
