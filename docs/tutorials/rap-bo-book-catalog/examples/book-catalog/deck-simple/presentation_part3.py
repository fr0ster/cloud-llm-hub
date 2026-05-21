"""Part 3 — Content slides.

Infographic-heavy walkthrough of the AI-assisted RAP-BO tutorial.
Source: docs/tutorials/rap-bo-book-catalog/README.md.
"""

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
    DiagramCanvas,
    DiagramNode,
    DiagramConnection,
    NodeStyle,
    ConnectionLineStyle,
    ConnectionConnectorStyle,
    ChevronProcess,
    ChevronStep,
    ChevronWidth,
    ProcessDirection,
)


INCH = 914400


def _node(left, top, w, h, text, content, color,
          style=NodeStyle.ROUNDED_RECTANGLE, bold=True, font_size=13):
    return DiagramNode(
        left=left, top=top, width=w, height=h,
        text=text, content=content,
        fill_color=color, style=style,
        bold=bold, font_size=font_size,
    )


def _arrow(s, e, text=None,
           style=ConnectionConnectorStyle.STRAIGHT,
           line=ConnectionLineStyle.SOLID):
    return DiagramConnection(
        start_node_index=s, end_node_index=e,
        style=style, line_style=line,
        connection_text=text, end_arrow=True,
    )


def generate_part3(prs: EPAMPresentation):
    # ============================================================
    # Slide — The pipeline
    # ============================================================
    _, content_p = prs.add_default_slide(
        title="The pipeline · idea to running app",
        upsubtitle="FOUR PHASES · ONE PIPE",
    )

    # 5 horizontal nodes: idea -> P1 -> P2 -> P3 -> P4 -> app
    # Lay out one big chevron-style row.
    nw = int(1.65 * INCH)
    nh = int(1.15 * INCH)
    gap = int(0.18 * INCH)
    cols = 6
    row_total = cols * nw + (cols - 1) * gap
    row_left = (content_p.width - row_total) // 2
    row_top = int(0.4 * INCH)

    pipeline_nodes = [
        _node(row_left + 0 * (nw + gap), row_top, nw, nh,
              "Your idea", "plain words · no ABAP",
              EPAMColor.Light_Gray),
        _node(row_left + 1 * (nw + gap), row_top, nw, nh,
              "Phase 1", "business-requirements",
              EPAMColor.Light_Blue),
        _node(row_left + 2 * (nw + gap), row_top, nw, nh,
              "Phase 2", "tech-spec",
              EPAMColor.Light_Teal),
        _node(row_left + 3 * (nw + gap), row_top, nw, nh,
              "Phase 3", "impl-plan",
              EPAMColor.Light_Magenta),
        _node(row_left + 4 * (nw + gap), row_top, nw, nh,
              "Phase 4", "active SAP objects",
              EPAMColor.Light_Orange),
        _node(row_left + 5 * (nw + gap), row_top, nw, nh,
              "Running app", "Fiori preview",
              EPAMColor.Light_Red),
    ]
    pipeline_conns = [_arrow(i, i + 1) for i in range(5)]

    prs.add_diagram_canvas(
        content_p,
        DiagramCanvas(
            left=0, top=0,
            width=content_p.width, height=content_p.height - int(1.2 * INCH),
            nodes=pipeline_nodes,
            connections=pipeline_conns,
            border=False,
        ),
        background=Background.LIGHT,
    )

    # Footer callout — RAG stores the artifacts between phases
    prs.add_block(
        content_p,
        Block(
            left=0, bottom=0,
            width=content_p.width, height=int(1.0 * INCH),
            content=(
                "Phases 1-3 save their artifact into a RAG collection. "
                "Phase 4 pulls plan + spec from RAG · you do not retype DDL."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.MEDIUM,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Phases 1-3 compared
    # ============================================================
    _, content_c = prs.add_default_slide(
        title="Phases 1-3 · documents only",
        upsubtitle="WHO DOES WHAT",
    )

    def _phase_block(title, your_role, ai_role, input_, output, color):
        return Block(
            left=0, top=0, width=0, height=0,
            title=title,
            style=BlockStyle.SOLID_FILL,
            color=color,
            rich_content=[
                ContentParagraph(runs=[
                    TextRun(text="You: ", bold=True), TextRun(text=your_role)]),
                ContentParagraph(runs=[
                    TextRun(text="AI: ", bold=True), TextRun(text=ai_role)]),
                ContentParagraph(runs=[
                    TextRun(text="In: ", bold=True), TextRun(text=input_)]),
                ContentParagraph(runs=[
                    TextRun(text="Out: ", bold=True),
                    TextRun(text=output, bold=True, italic=True)]),
            ],
        )

    prs.add_block_grid(
        content_c,
        BlockGrid(
            left=0, top=0,
            width=content_c.width, height=content_c.height,
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                _phase_block(
                    "Phase 1 · Requirements",
                    "domain expert · approve entities/rules",
                    "business analyst · formalize",
                    "your idea in plain words",
                    "business-requirements (RAG)",
                    EPAMColor.Light_Blue),
                _phase_block(
                    "Phase 2 · Tech spec",
                    "architect · review draft",
                    "technical writer · propose DDL",
                    "business-requirements (RAG)",
                    "tech-spec (RAG · draft, evolves)",
                    EPAMColor.Light_Teal),
                _phase_block(
                    "Phase 3 · Plan",
                    "project manager · check order",
                    "lead developer · order steps",
                    "tech-spec (RAG)",
                    "impl-plan (RAG · ordered steps)",
                    EPAMColor.Light_Magenta),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Phase 4 layer order
    # ============================================================
    _, content_l = prs.add_default_slide(
        title="Phase 4 · build layer by layer",
        upsubtitle="DEPENDENCY ORDER · LAYERED",
    )

    prs.add_chevron_process(
        content_l,
        ChevronProcess(
            left=0, top=int(0.5 * INCH),
            width=content_l.width, height=int(2.0 * INCH),
            direction=ProcessDirection.HORIZONTAL,
            chevron_width=ChevronWidth.NARROW,
            text_size=TextSize.SMALL,
            auto_color_rotation=True,
            steps=[
                ChevronStep(label="Package", content="prefix Z##_"),
                ChevronStep(label="Domains", content="value ranges"),
                ChevronStep(label="Data el", content="typed fields"),
                ChevronStep(label="Tables", content="persistent + draft"),
                ChevronStep(label="CDS R", content="interface views"),
                ChevronStep(label="CDS C", content="projection"),
                ChevronStep(label="BDEF", content="behaviour"),
                ChevronStep(label="Service", content="definition + bind"),
            ],
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content_l,
        Block(
            left=0, bottom=0,
            width=content_l.width, height=int(1.4 * INCH),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
            rich_content=[
                ContentParagraph(
                    runs=[TextRun(text="Rule: ", bold=True),
                          TextRun(text="3-4 objects per prompt · activate before next layer.")]),
                ContentParagraph(
                    runs=[TextRun(text="Trust check: ", bold=True),
                          TextRun(text='"Active" is a claim until ReadDomain / ReadTable returns active: true.')]),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Create-check-fix loop
    # ============================================================
    _, content_x = prs.add_default_slide(
        title="Complex objects · never assume first attempt works",
        upsubtitle="CREATE · CHECK · FIX",
    )

    # 4-node cycle around center
    cw, ch = int(1.9 * INCH), int(0.95 * INCH)
    cx = content_x.width // 2
    cy = content_x.height // 2
    rx = int(2.4 * INCH)
    ry = int(1.3 * INCH)

    nodes = [
        _node(cx - cw // 2, cy - ry - ch // 2, cw, ch,
              "Create", "no activate yet", EPAMColor.Light_Blue),
        _node(cx + rx - cw // 2, cy - ch // 2, cw, ch,
              "Check", "syntax · refs", EPAMColor.Light_Sky,
              style=NodeStyle.DECISION),
        _node(cx - cw // 2, cy + ry - ch // 2, cw, ch,
              "Fix", "agent edits spec · retry",
              EPAMColor.Light_Orange),
        _node(cx - rx - cw // 2, cy - ch // 2, cw, ch,
              "Activate", "whole layer together",
              EPAMColor.Light_Teal),
    ]
    conns = [
        _arrow(0, 1, style=ConnectionConnectorStyle.CURVED),
        _arrow(1, 2,
               style=ConnectionConnectorStyle.CURVED,
               line=ConnectionLineStyle.DASHED,
               text="errors"),
        _arrow(2, 0,
               style=ConnectionConnectorStyle.CURVED,
               line=ConnectionLineStyle.DASHED,
               text="retry"),
        _arrow(1, 3,
               style=ConnectionConnectorStyle.CURVED,
               text="clean"),
    ]
    prs.add_diagram_canvas(
        content_x,
        DiagramCanvas(
            left=0, top=0,
            width=content_x.width, height=content_x.height,
            nodes=nodes, connections=conns,
            border=False,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Skill catalog (single-task skills)
    # ============================================================
    _, content_sk = prs.add_default_slide(
        title="Skill catalog · one task per file",
        upsubtitle="16 SKILLS · 33-74 LINES EACH",
    )

    prs.add_block_grid(
        content_sk,
        BlockGrid(
            left=0, top=0,
            width=content_sk.width, height=int(2.8 * INCH),
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.EXTRA_SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="DDIC layer",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Blue,
                      rich_content=[
                          ContentParagraph(text="creating-domain", is_bullet=True),
                          ContentParagraph(text="creating-data-element", is_bullet=True),
                          ContentParagraph(text="creating-persistent-table", is_bullet=True),
                          ContentParagraph(text="creating-draft-table", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="RAP layer",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Teal,
                      rich_content=[
                          ContentParagraph(text="creating-interface-cds-view", is_bullet=True),
                          ContentParagraph(text="creating-projection-cds-view", is_bullet=True),
                          ContentParagraph(text="creating-metadata-extension", is_bullet=True),
                          ContentParagraph(text="creating-bdef", is_bullet=True),
                          ContentParagraph(text="creating-bimp", is_bullet=True),
                          ContentParagraph(text="creating-projection-bdef", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Service · operational",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Orange,
                      rich_content=[
                          ContentParagraph(text="creating-service-definition", is_bullet=True),
                          ContentParagraph(text="creating-service-binding", is_bullet=True),
                          ContentParagraph(text="enforcing-target-package", is_bullet=True),
                          ContentParagraph(text="avoiding-hallucinations", is_bullet=True),
                          ContentParagraph(text="managing-rag-artifacts", is_bullet=True),
                          ContentParagraph(text="activating-objects", is_bullet=True),
                      ]),
            ],
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content_sk,
        Block(
            left=0, bottom=0,
            width=content_sk.width, height=int(0.9 * INCH),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.SMALL,
            rich_content=[
                ContentParagraph(runs=[
                    TextRun(text="Why split: ", bold=True),
                    TextRun(text="one skill = one task · no stage / phase references inside · "
                                 "load only what the current step needs · easier to evolve · "
                                 "fits on one screen.")]),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Skill example · activating-objects.md as-is
    # ============================================================
    _, content_se = prs.add_default_slide(
        title="Skill example · activating-objects.md",
        upsubtitle="WHOLE FILE · AS-IS",
    )

    # Render the actual file content verbatim — small font, single block.
    # Markdown source is shown with its natural structure (headings, bullets,
    # tables collapsed to inline form). No re-interpretation.
    skill_lines = [
        "name: Activating Objects",
        "tags: [sap, activation, governance]",
        "",
        "# Activating Objects",
        "",
        "## Hard rules",
        "",
        "- Never bare \"Activate all inactive objects\" — filter by prefix Z##_.",
        "- Check before activating. Partial failures cascade.",
        "- Group activation for circular refs (CDS R-views, C-views).",
        "- BDEF + BIMP must be activated together.",
        "- BDEFs: ActivateBehaviorDefinition. ActivateObjects = DDIC + CDS only.",
        "",
        "## After activation",
        "",
        "- Re-run syntax check to surface warnings hidden by earlier errors.",
        "- Read… each object — response must include active: true.",
        "",
        "## Common error fix",
        "",
        "  Activated unrelated objects   → missing prefix filter",
        "  Still inactive after activate → wrong tool: use ActivateBehaviorDefinition",
        "  Half-active layer             → activated one-by-one; group-activate whole layer",
        "  Syntax clean, activate fails  → prerequisite layer not active",
    ]

    paragraphs = []
    for line in skill_lines:
        if line == "":
            paragraphs.append(ContentParagraph(
                runs=[TextRun(text=" ", font_size=9)]
            ))
        else:
            paragraphs.append(ContentParagraph(
                runs=[TextRun(text=line, font_size=9, text_size=TextSize.SMALL)]
            ))

    prs.add_block(
        content_se,
        Block(
            left=0, top=0,
            width=content_se.width, height=content_se.height,
            style=BlockStyle.SIMPLE,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            horizontal_alignment=HorizontalAlignment.LEFT,
            rich_content=paragraphs,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Artifacts across phases (same entity through pipeline)
    # ============================================================
    _, content_af = prs.add_default_slide(
        title="The same entity moves through the pipeline",
        upsubtitle="AUTHOR · FROM IDEA TO OBJECT",
    )

    prs.add_block_grid(
        content_af,
        BlockGrid(
            left=0, top=0,
            width=content_af.width, height=content_af.height,
            columns=4, gap=GapSize.SMALL,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.EXTRA_SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="Phase 1 · business",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Blue,
                      rich_content=[
                          ContentParagraph(runs=[TextRun(text="Entity: Author", bold=True)]),
                          ContentParagraph(text="Name (string 100, required)", is_bullet=True),
                          ContentParagraph(text="Country (string 50)", is_bullet=True),
                          ContentParagraph(text="Birth Year (int 4)", is_bullet=True),
                          ContentParagraph(text="Biography (text)", is_bullet=True),
                          ContentParagraph(runs=[
                              TextRun(text="Rule: ", bold=True),
                              TextRun(text="name unique; birth-year 1000..now.")]),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Phase 2 · spec",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Teal,
                      rich_content=[
                          ContentParagraph(runs=[TextRun(text="Table Z##_AUTHOR", bold=True)]),
                          ContentParagraph(text="author_id uuid · key", is_bullet=True),
                          ContentParagraph(text="name z##_e_name (z##_d_name CHAR 100)", is_bullet=True),
                          ContentParagraph(text="country z##_e_country", is_bullet=True),
                          ContentParagraph(text="birth_year z##_e_year (NUMC 4)", is_bullet=True),
                          ContentParagraph(text="biography STRING", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Phase 3 · plan",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Magenta,
                      rich_content=[
                          ContentParagraph(runs=[TextRun(text="Step group · Author", bold=True)]),
                          ContentParagraph(text="1.1 create 5 domains", is_bullet=True),
                          ContentParagraph(text="1.2 create 5 data elements", is_bullet=True),
                          ContentParagraph(text="2.1 create Z##_AUTHOR + draft", is_bullet=True),
                          ContentParagraph(text="3.1 CDS Z##_R_AUTHOR + C view", is_bullet=True),
                          ContentParagraph(text="4.1 BDEF + BIMP + activate", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Phase 4 · objects",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Orange,
                      rich_content=[
                          ContentParagraph(runs=[TextRun(text="Active on SAP", bold=True)]),
                          ContentParagraph(text="DOMA · DTEL · 5+5", is_bullet=True),
                          ContentParagraph(text="TABL Z##_AUTHOR + _D draft", is_bullet=True),
                          ContentParagraph(text="DDLS Z##_R_AUTHOR + C", is_bullet=True),
                          ContentParagraph(text="BDEF + BIMP class", is_bullet=True),
                          ContentParagraph(text="Service + binding", is_bullet=True),
                      ]),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — What got built · 72 objects
    # ============================================================
    _, content_b = prs.add_default_slide(
        title="What got built · 72 objects, all active",
        upsubtitle="4 ENTITIES · 1 RAP APP",
    )

    metrics_h = int(1.7 * INCH)
    prs.add_block_grid(
        content_b,
        BlockGrid(
            left=0, top=0,
            width=content_b.width, height=metrics_h,
            columns=4, gap=GapSize.SMALL,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      metric_value="72",
                      content="objects active",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Teal,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="77",
                      content="API prompts in P4",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Blue,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="~$19",
                      content="API cost · vs ~$2k manual",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Orange,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="~3h",
                      content="wall-clock · vs ~2 weeks",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Magenta,
                      horizontal_alignment=HorizontalAlignment.CENTER),
            ],
        ),
        background=Background.LIGHT,
    )

    breakdown_top = metrics_h + int(0.2 * INCH)
    breakdown_h = content_b.height - breakdown_top
    prs.add_block_grid(
        content_b,
        BlockGrid(
            left=0, top=breakdown_top,
            width=content_b.width, height=breakdown_h,
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="DDIC layer",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Blue,
                      rich_content=[
                          ContentParagraph(text="20 domains (DOMA)", is_bullet=True),
                          ContentParagraph(text="20 data elements (DTEL)", is_bullet=True),
                          ContentParagraph(text="4 persistent tables (TABL)", is_bullet=True),
                          ContentParagraph(text="4 draft tables (TABL _D)", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="RAP layer",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Teal,
                      rich_content=[
                          ContentParagraph(text="4 interface CDS (Z##_R_*)", is_bullet=True),
                          ContentParagraph(text="4 projection CDS (Z##_C_*)", is_bullet=True),
                          ContentParagraph(text="4 metadata extensions", is_bullet=True),
                          ContentParagraph(text="4 BDEF + 4 BIMP classes", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Service · UI",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Orange,
                      rich_content=[
                          ContentParagraph(text="1 service definition", is_bullet=True),
                          ContentParagraph(text="1 OData V4 binding (published)", is_bullet=True),
                          ContentParagraph(text="Fiori Elements preview · CRUD + draft", is_bullet=True),
                          ContentParagraph(text="Author shows by name, not UUID", is_bullet=True),
                      ]),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Things that go wrong
    # ============================================================
    _, content_w = prs.add_default_slide(
        title="Two failure modes · how to catch them",
        upsubtitle="DRIFT · HALLUCINATION",
    )
    prs.add_block_grid(
        content_w,
        BlockGrid(
            left=0, top=0,
            width=content_w.width, height=content_w.height,
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="Spec / plan drift",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Orange,
                      rich_content=[
                          ContentParagraph(runs=[
                              TextRun(text="Symptom: ", bold=True),
                              TextRun(text="extra objects, missing ones, silent renames.")]),
                          ContentParagraph(runs=[
                              TextRun(text="Catch: ", bold=True),
                              TextRun(text="quote the plan back; force exact list.")]),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Hallucination",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Red,
                      rich_content=[
                          ContentParagraph(runs=[
                              TextRun(text="Symptom: ", bold=True),
                              TextRun(text='"All N active" with no Executing trace.')]),
                          ContentParagraph(runs=[
                              TextRun(text="Catch: ", bold=True),
                              TextRun(text="low token count · ask agent to read each object back.")]),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Phase confusion",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Magenta,
                      rich_content=[
                          ContentParagraph(runs=[
                              TextRun(text="Symptom: ", bold=True),
                              TextRun(text="Create/Update runs during Phase 1-3.")]),
                          ContentParagraph(runs=[
                              TextRun(text="Catch: ", bold=True),
                              TextRun(text='say "document only, not system" · revert.')]),
                      ]),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Outcome
    # ============================================================
    _, content_o = prs.add_default_slide(
        title="What you walk away with",
        upsubtitle="OUTCOMES · 1-2 HOURS",
    )
    prs.add_block_grid(
        content_o,
        BlockGrid(
            left=0, top=0,
            width=content_o.width, height=int(2.0 * INCH),
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      metric_value="1 app",
                      content="active RAP BO · Fiori preview",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Teal,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="3 docs",
                      content="business-req · tech-spec · impl-plan in RAG",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Blue,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="1-2 h",
                      content="end to end wall-clock",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Orange,
                      horizontal_alignment=HorizontalAlignment.CENTER),
            ],
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content_o,
        Block(
            left=0, bottom=0,
            width=content_o.width, height=int(2.0 * INCH),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                ContentParagraph(runs=[
                    TextRun(text="What you learn: ", bold=True),
                    TextRun(text="turn ideas into requirements, review AI specs, "
                                 "plan in dependency order, build layer by layer.")]),
                ContentParagraph(runs=[
                    TextRun(text="What stays yours: ", bold=True),
                    TextRun(text="every business decision and every field mapping.")]),
                ContentParagraph(runs=[
                    TextRun(text="What AI gives you: ", bold=True),
                    TextRun(text="the fastest pair programmer you can get · "
                                 "only if you lead.")]),
            ],
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
