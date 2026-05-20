"""sFTP usage-analysis deck — EPAM Accelerator fact-sheet format.

Single-file rewrite (~10 slides) matching the manager's SDLC Accelerators
sample structure. Same approximation strategy as the code-review deck:

    [ GREY 1/3 ]              [ WHITE 2/3 ]
      TARGET SEGMENT            Business Problem
      Differentiators           Business Value
                                3 KPIs (hero metrics)
"""

from simple_deck import (
    EPAMPresentation,
    Background,
    Block,
    BlockGrid,
    BlockStyle,
    ContentParagraph,
    TextRun,
    TextSize,
    GapSize,
    BlockMarginPreset,
    EPAMColor,
    HorizontalAlignment,
    format_spaced_text,
)


# ---------- Shared content building blocks ----------

TARGET_SEGMENT_LINES = [
    ("Geography", "Any region"),
    ("Industry", "Any vertical with SAP"),
    ("Company size", "Any"),
    ("Persona", "Migration architect · integration lead"),
]

DIFFERENTIATORS = [
    "Multi-marker scan discipline",
    "Source-cited verdicts per object",
    "Wrapper FUGRs auto-discovered",
    "Iterative scope expansion",
]


def add_target_block(prs, area, bg):
    prs.add_block(
        area,
        Block(
            left=0,
            top=0,
            width=area.width,
            height=0,
            title="TARGET SEGMENT",
            rich_content=[
                ContentParagraph(
                    runs=[
                        TextRun(text=f"{label}", bold=True),
                        TextRun(text=f"  {value}"),
                    ]
                )
                for label, value in TARGET_SEGMENT_LINES
            ],
            style=BlockStyle.SIMPLE,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=bg,
    )


def add_differentiators_block(prs, area, top, bg):
    prs.add_block(
        area,
        Block(
            left=0,
            top=top,
            width=area.width,
            height=0,
            title="Differentiators",
            rich_content=[
                ContentParagraph(text=d, is_bullet=True) for d in DIFFERENTIATORS
            ],
            style=BlockStyle.SIMPLE,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=bg,
    )


def add_fact_sheet(
    prs,
    axis_name,
    business_problem,
    business_value,
    summary,
    kpis,
):
    """Build one fact-sheet slide. kpis = exactly 3 (metric, caption) tuples."""
    slide, grey, white = prs.add_grey_and_white_split_slide(
        title=axis_name,
        section_title="EPAM ACCELERATOR",
        grey_width_ratio="1/3",
    )

    add_target_block(prs, grey, Background.LIGHT)
    add_differentiators_block(prs, grey, top=2200000, bg=Background.LIGHT)

    prs.add_block(
        white,
        Block(
            left=0,
            top=0,
            width=white.width,
            height=0,
            title="Business Problem",
            content=business_problem,
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )
    prs.add_block(
        white,
        Block(
            left=0,
            top=1200000,
            width=white.width,
            height=0,
            title="Business Value",
            content=business_value,
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Teal,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )
    prs.add_block(
        white,
        Block(
            left=0,
            top=2400000,
            width=white.width,
            height=0,
            content=summary,
            style=BlockStyle.SIMPLE,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )

    kpi_blocks = [
        Block(
            left=0, top=0, width=0, height=0,
            metric_value=metric,
            content=caption,
            style=BlockStyle.HERO_METRIC_TO_THE_LEFT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        )
        for metric, caption in kpis
    ]
    prs.add_block_grid(
        white,
        BlockGrid(
            left=0,
            top=3300000,
            width=white.width,
            height=0,
            columns=3,
            gap=GapSize.SMALL,
            blocks=kpi_blocks,
            style=BlockStyle.HERO_METRIC_TO_THE_LEFT,
            auto_color_rotation=False,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
        ),
        background=Background.LIGHT,
    )


# ---------- Build the deck ----------

prs = EPAMPresentation(output_path="../report.accelerator.pptx")

# --- Slide 1 — Cover ---
prs.add_cover_slide_dark(
    presentation_title="sFTP Usage Analysis",
    description="ABAP Estate Discovery · EPAM SDLC Accelerator",
    date=format_spaced_text("MAY 2026"),
)

# --- Slide 2 — Agenda ---
prs.add_contents_slide(
    contents=[
        "The Task",
        "Methods",
        "Usage Map",
        "Migration Handoff",
        "Run economics",
        "Q&A",
    ]
)

# --- Slide 3 — Section Header ---
prs.add_section_header_slide(
    section_title="The Analysis",
    section_description=(
        "13 stakeholder seeds → 19 confirmed SFTP callers. One mechanism, two auth shapes, ~2h."
    ),
    section_number="01",
)

# --- Slide 4 — Headline numbers (snapshot) ---
slide_s4, area_s4 = prs.add_default_slide(
    title="Migration scope, in numbers",
    upsubtitle="ONE RUN · DS4_CLH",
)
prs.add_block_grid(
    area_s4,
    BlockGrid(
        left=0, top=0, width=area_s4.width, height=2400000,
        columns=6,
        gap=GapSize.SMALL,
        blocks=[
            Block(left=0, top=0, width=0, height=0, metric_value="19",
                  content="confirmed objects", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Blue, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="+46%",
                  content="vs 13-seed list", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Orange, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="5",
                  content="business domains", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Teal, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="11",
                  content="SM69 endpoints", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Purple, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="2",
                  content="auth modes", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Lavender, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="~2h",
                  content="wall-clock", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Green, horizontal_alignment=HorizontalAlignment.CENTER),
        ],
        style=BlockStyle.HERO_METRIC_ON_TOP,
        auto_color_rotation=False,
    ),
    background=Background.LIGHT,
)
prs.add_block(
    area_s4,
    Block(
        left=0, top=2700000, width=area_s4.width, height=0,
        content="Comparable manual analysis: 4–12 hours.",
        style=BlockStyle.CALLOUT, color=EPAMColor.Light_Blue,
        text_size=TextSize.MEDIUM,
    ),
    background=Background.LIGHT,
)

# --- Slide 5 — Task fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="The Task",
    business_problem=(
        "Migration teams inherit an ABAP estate that talks to SFTP in "
        "dozens of places — bank statements, payroll, healthcare claims. "
        "No-one has a complete inventory; stakeholder lists are partial."
    ),
    business_value=(
        "AI agent triages a 13-seed stakeholder list, produces an SFTP "
        "verdict per object (yes/no/unclear) with code citations, and "
        "calls out blind spots before migration work starts."
    ),
    summary="13 seeds → 8 confirmed callers, 5 dropped — all source-cited.",
    kpis=[
        ("13", "seeds"),
        ("8", "confirmed"),
        ("5", "dropped"),
    ],
)

# --- Slide 6 — Methods fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="Methods",
    business_problem=(
        "Every legacy SFTP consumer can use a different mechanism: "
        "OPEN DATASET, SXPG, SM69, FM wrappers. Without a uniform model "
        "the migration team cannot scope the replacement layer."
    ),
    business_value=(
        "AI confirms every confirmed SFTP report reduces to ONE pattern: "
        "SXPG_COMMAND_EXECUTE → SM69 entry → OS sftp/scp. Two auth shapes "
        "(key-based + password) — both must be supported."
    ),
    summary="One mechanism, two auth shapes — replacement plan is bounded.",
    kpis=[
        ("1", "underlying mechanism"),
        ("2", "auth shapes"),
        ("16", "FUGR/PROG callers"),
    ],
)

# --- Slide 7 — Usage Map fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="Usage Map",
    business_problem=(
        "Stakeholder lists undercount SFTP usage. Mass scans without "
        "discipline either time out or miss objects that read credentials "
        "via wrapper FUGRs instead of literal SFTP names."
    ),
    business_value=(
        "Seven independent SearchSource scans, three credential markers, "
        "wrapper FUGR discovery — surfaces 19 confirmed objects (16 PROG "
        "reports + 3 FUGRs), 46% more than the original seed list."
    ),
    summary="19 objects · 5 business domains · 11 SM69 endpoints inventoried.",
    kpis=[
        ("+46%", "scope vs seed list"),
        ("7", "independent scans"),
        ("3", "wrapper FUGRs found"),
    ],
)

# --- Slide 8 — Migration handoff fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="Migration Handoff",
    business_problem=(
        "Migration teams need a per-endpoint plan, not a flat list. "
        "Shared SM69 commands, PGP-wrapped pushes, and 11 distinct OS-side "
        "endpoints have to be cut over without breaking active banking "
        "and healthcare flows."
    ),
    business_value=(
        "AI produces a cutover order (Banking → Healthcare → Payroll → "
        "DMS/eRx), surfaces 3 shared SM69 commands, flags PGP and "
        "password-only paths, and lists open questions for Basis."
    ),
    summary="Per-endpoint cutover plan with shared-command flags and open Qs.",
    kpis=[
        ("4", "cutover phases"),
        ("11", "endpoints"),
        ("3", "open questions"),
    ],
)

# --- Slide 9 — Retro fact-sheet (run economics) ---
slide_s9, area_s9 = prs.add_default_slide(
    title="Run economics",
    upsubtitle="AI VS MANUAL ANALYSIS",
)
prs.add_block_grid(
    area_s9,
    BlockGrid(
        left=0, top=0, width=area_s9.width, height=0,
        columns=4, gap=GapSize.SMALL,
        blocks=[
            Block(left=0, top=0, width=0, height=0, metric_value="~2h",
                  content="Wall-clock", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Blue, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="1.05M",
                  content="executor tokens", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Teal, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="264",
                  content="model requests", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Purple, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="~$66",
                  content="controller share", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Orange, horizontal_alignment=HorizontalAlignment.CENTER),
        ],
        style=BlockStyle.HERO_METRIC_ON_TOP,
        auto_color_rotation=False,
    ),
    background=Background.LIGHT,
)
prs.add_block(
    area_s9,
    Block(
        left=0, top=2700000, width=area_s9.width, height=0,
        content="7 SearchSource scans · 1 destination · 19 confirmed objects. Manual estimate: 4–12 hours.",
        style=BlockStyle.CALLOUT, color=EPAMColor.Light_Blue,
        text_size=TextSize.MEDIUM,
    ),
    background=Background.LIGHT,
)

# --- Slide 10 — Thank you ---
prs.add_default_slide_dark(
    title="Questions?",
    upsubtitle="FULL ARTIFACTS IN TUTORIAL",
)

prs.save()
print("Presentation created: ../report.accelerator.pptx")
