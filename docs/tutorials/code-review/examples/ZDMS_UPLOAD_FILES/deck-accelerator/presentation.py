"""ZDMS_UPLOAD_FILES code-review deck — EPAM Accelerator fact-sheet format.

Single-file rewrite (no part splitting — total ~10 slides) to mimic the
manager's SDLC Accelerators sample. The manager's deck uses a corporate
"Narrow-Grey" master that simple-deck does not ship; we approximate by
using `add_grey_and_white_split_slide` with a structured block layout:

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
    ("Persona", "ABAP dev · architect · EM"),
]

DIFFERENTIATORS = [
    "Parallel multi-axis review",
    "Read-only ADT tooling — safe on prod",
    "Evidence cited per finding",
    "LLM-agnostic, runs in any subaccount",
]


def add_target_block(prs, area, bg):
    """Compact 'TARGET SEGMENT' block on the grey panel."""
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
    """Build one fact-sheet slide for a review axis.

    kpis is a list of exactly 3 (metric_value, caption) tuples.
    """
    slide, grey, white = prs.add_grey_and_white_split_slide(
        title=axis_name,
        section_title="EPAM ACCELERATOR",
        grey_width_ratio="1/3",
    )

    # --- Grey 1/3 (left): TARGET SEGMENT + Differentiators ---
    add_target_block(prs, grey, Background.LIGHT)
    # Differentiators block sits below TARGET SEGMENT
    add_differentiators_block(prs, grey, top=2200000, bg=Background.LIGHT)

    # --- White 2/3 (right): Problem + Value + 3 KPIs ---
    # Problem (top)
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

    # Value
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

    # Summary
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

    # 3 KPIs — hero metric to the left, in a horizontal grid below
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
    presentation_title="ZDMS_UPLOAD_FILES",
    description="ABAP Code Review · EPAM SDLC Accelerator",
    date=format_spaced_text("MAY 2026"),
)

# --- Slide 2 — Agenda ---
prs.add_contents_slide(
    contents=[
        "Review overview",
        "Security",
        "Performance",
        "Clean Core",
        "Maintainability",
        "Summary & retro",
    ]
)

# --- Slide 3 — Section Header (intro to fact-sheets) ---
prs.add_section_header_slide(
    section_title="The Review",
    section_description=(
        "One ABAP report, four parallel review axes. 30 findings, ~6 min wall-clock."
    ),
    section_number="01",
)

# --- Slide 4 — Exec snapshot (severity matrix + headline number) ---
slide_s4, area_s4 = prs.add_default_slide(
    title="30 findings across 4 axes",
    upsubtitle="ONE REPORT · ONE AI PASS",
)
prs.add_block_grid(
    area_s4,
    BlockGrid(
        left=0, top=0, width=area_s4.width, height=2400000,
        columns=5,
        gap=GapSize.MEDIUM,
        blocks=[
            Block(left=0, top=0, width=0, height=0, metric_value="0",
                  content="CRITICAL", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Red, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="10",
                  content="HIGH", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Orange, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="3",
                  content="MEDIUM", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Teal, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="17",
                  content="LOW", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Gray, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="6 min",
                  content="wall-clock for full 4-axis review",
                  style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Blue, horizontal_alignment=HorizontalAlignment.CENTER),
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
        content="Comparable senior-engineer manual review: 4–8 hours.",
        style=BlockStyle.CALLOUT, color=EPAMColor.Light_Blue,
        text_size=TextSize.MEDIUM,
    ),
    background=Background.LIGHT,
)

# --- Slide 5 — Security fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="Security",
    business_problem=(
        "Legacy ABAP reports that drive SAP via SXPG_COMMAND_EXECUTE / "
        "OS shell expose auth gaps, shell-injection risk, and "
        "information disclosure that automated review must catch."
    ),
    business_value=(
        "AI surfaces 4 findings in seconds: two missing AUTHORITY-CHECK "
        "calls before SXPG, one shell-injection in built parameters, "
        "and one info-disclosure leak via WRITE."
    ),
    summary=(
        "Two HIGH findings around OS command execution — fix before next release."
    ),
    kpis=[
        ("4", "findings"),
        ("2", "HIGH"),
        ("~45s", "review time"),
    ],
)

# --- Slide 6 — Performance fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="Performance",
    business_problem=(
        "Per-row function-module calls inside LOOP, plus wide SELECT * "
        "patterns, dominate ABAP runtime cost in custom reports — and "
        "are routinely missed by manual review."
    ),
    business_value=(
        "AI flags 4 findings: FORMAT_MESSAGE per row, ZDMS_UPLOAD_DOCUMENTS "
        "per row, plus two wide SELECT * patterns ready to fix in the "
        "next sprint."
    ),
    summary=(
        "Two HIGH (loop-bound FM calls) + two MEDIUM (wide SELECTs) — backlog ready."
    ),
    kpis=[
        ("4", "findings"),
        ("2", "HIGH"),
        ("~45s", "review time"),
    ],
)

# --- Slide 7 — Clean Core fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="Clean Core",
    business_problem=(
        "On-prem ABAP reports often rely on SXPG, AL11 file I/O, "
        "and direct SELECT on standard tables — all disallowed in "
        "S/4HANA Cloud and silent blockers for a Cloud move."
    ),
    business_value=(
        "AI confirms 6 HIGH Clean Core blockers in this single report; "
        "all 6 must be replaced with released APIs / Integration Suite "
        "before any Cloud migration plan."
    ),
    summary="Verdict: rewrite, not patch — if S/4HANA Cloud is on the roadmap.",
    kpis=[
        ("6", "findings"),
        ("100%", "HIGH"),
        ("~45s", "review time"),
    ],
)

# --- Slide 8 — Maintainability fact-sheet ---
add_fact_sheet(
    prs,
    axis_name="Maintainability",
    business_problem=(
        "Style violations, obsolete constructs and dead code accumulate "
        "silently across legacy ABAP — slowing every later change without "
        "ever producing a hard failure."
    ),
    business_value=(
        "AI lists 16 LOW findings (obsolete CONCATENATE, WITH HEADER LINE, "
        "magic literals, dead vars) with severity-tagged cards — clean up "
        "during normal evolution, not as a dedicated sprint."
    ),
    summary="16 LOW · steady tech-debt · address during normal evolution.",
    kpis=[
        ("16", "findings"),
        ("0", "blockers"),
        ("~45s", "review time"),
    ],
)

# --- Slide 9 — Cross-cutting summary / verdict ---
slide_s9, area_s9 = prs.add_default_slide_dark(
    title="Significant rework needed",
    upsubtitle="ON-PREM OK · CLOUD BLOCKED",
)
prs.add_block_grid(
    area_s9,
    BlockGrid(
        left=0, top=0, width=area_s9.width, height=0,
        columns=2, gap=GapSize.MEDIUM,
        blocks=[
            Block(
                left=0, top=0, width=0, height=0,
                title="Schedule a focused fix sprint",
                content="Address all 10 HIGH issues before the next release.",
                style=BlockStyle.SOLID_FILL,
                color=EPAMColor.Orange,
            ),
            Block(
                left=0, top=0, width=0, height=0,
                title="Migration call",
                content="6 HIGH Clean Core findings = rewrite the SFTP path before any S/4HANA Cloud move.",
                style=BlockStyle.SOLID_FILL,
                color=EPAMColor.Cyan,
            ),
        ],
        style=BlockStyle.SOLID_FILL,
        auto_color_rotation=False,
    ),
    background=Background.DARK,
)

# --- Slide 10 — Retro fact-sheet (run economics) ---
slide_s10, area_s10 = prs.add_default_slide(
    title="Run economics",
    upsubtitle="AI VS MANUAL REVIEW",
)
prs.add_block_grid(
    area_s10,
    BlockGrid(
        left=0, top=0, width=area_s10.width, height=0,
        columns=4, gap=GapSize.SMALL,
        blocks=[
            Block(left=0, top=0, width=0, height=0, metric_value="~6 min",
                  content="Wall-clock", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Blue, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="~45s",
                  content="Slowest axis", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Teal, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="381k",
                  content="executor tokens (gpt-5.2)", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Purple, horizontal_alignment=HorizontalAlignment.CENTER),
            Block(left=0, top=0, width=0, height=0, metric_value="~$28",
                  content="controller-side share", style=BlockStyle.HERO_METRIC_ON_TOP,
                  color=EPAMColor.Light_Orange, horizontal_alignment=HorizontalAlignment.CENTER),
        ],
        style=BlockStyle.HERO_METRIC_ON_TOP,
        auto_color_rotation=False,
    ),
    background=Background.LIGHT,
)
prs.add_block(
    area_s10,
    Block(
        left=0, top=2700000, width=area_s10.width, height=0,
        content="30 findings, 4 categories, one parallel run. Comparable manual review: 4–8 hours.",
        style=BlockStyle.CALLOUT, color=EPAMColor.Light_Blue,
        text_size=TextSize.MEDIUM,
    ),
    background=Background.LIGHT,
)

# --- Slide 11 — Thank you ---
prs.add_default_slide_dark(
    title="Questions?",
    upsubtitle="FULL ARTIFACTS IN TUTORIAL",
)

prs.save()
print("Presentation created: ../report.accelerator.pptx")
