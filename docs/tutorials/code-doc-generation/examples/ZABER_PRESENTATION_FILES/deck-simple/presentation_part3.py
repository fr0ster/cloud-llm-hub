"""Part 3 — Content slides for the code-documentation walkthrough."""

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
        title="The pipeline · existing code to spec",
        upsubtitle="FOUR PHASES",
    )

    nw = int(1.7 * INCH)
    nh = int(1.15 * INCH)
    gap = int(0.18 * INCH)
    cols = 5
    row_total = cols * nw + (cols - 1) * gap
    row_left = (content_p.width - row_total) // 2
    row_top = int(0.4 * INCH)

    pipeline_nodes = [
        _node(row_left + 0 * (nw + gap), row_top, nw, nh,
              "Existing code", "PROG · CLAS · FUGR",
              EPAMColor.Light_Gray),
        _node(row_left + 1 * (nw + gap), row_top, nw, nh,
              "Phase 1", "doc-task",
              EPAMColor.Light_Blue),
        _node(row_left + 2 * (nw + gap), row_top, nw, nh,
              "Phase 2", "analysis-plan",
              EPAMColor.Light_Teal),
        _node(row_left + 3 * (nw + gap), row_top, nw, nh,
              "Phase 3", "evidence-§N",
              EPAMColor.Light_Magenta),
        _node(row_left + 4 * (nw + gap), row_top, nw, nh,
              "Phase 4", "tech-spec",
              EPAMColor.Light_Orange),
    ]
    pipeline_conns = [_arrow(i, i + 1) for i in range(4)]

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

    prs.add_block(
        content_p,
        Block(
            left=0, bottom=0,
            width=content_p.width, height=int(1.0 * INCH),
            content=(
                "Every phase saves its artifact into RAG · phase 4 pulls them all back "
                "and assembles the final document. No retyped source."
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
        title="Phases 1-3 · what each one produces",
        upsubtitle="WHO DOES WHAT",
    )

    def _phase_block(title, your_role, ai_role, input_, output, color):
        return Block(
            left=0, top=0, width=0, height=0,
            title=title,
            style=BlockStyle.SOLID_FILL,
            color=color,
            rich_content=[
                ContentParagraph(runs=[TextRun(text="You: ", bold=True),
                                       TextRun(text=your_role)]),
                ContentParagraph(runs=[TextRun(text="AI: ", bold=True),
                                       TextRun(text=ai_role)]),
                ContentParagraph(runs=[TextRun(text="In: ", bold=True),
                                       TextRun(text=input_)]),
                ContentParagraph(runs=[TextRun(text="Out: ", bold=True),
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
                    "Phase 1 · Task framing",
                    "owner · pick target + format",
                    "intake analyst · summarise",
                    "your code + doc format",
                    "doc-task (RAG)",
                    EPAMColor.Light_Blue),
                _phase_block(
                    "Phase 2 · Analysis plan",
                    "auditor · check tool choices",
                    "analyst · pick tool per question",
                    "doc-task + question list",
                    "analysis-plan (RAG)",
                    EPAMColor.Light_Teal),
                _phase_block(
                    "Phase 3 · Evidence",
                    "verifier · check citations",
                    "evidence collector · run MCP",
                    "analysis-plan",
                    "evidence-§N (RAG)",
                    EPAMColor.Light_Magenta),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Phase 3 batches (read first, then deps)
    # ============================================================
    _, content_b = prs.add_default_slide(
        title="Phase 3 · read the code first, then the deps",
        upsubtitle="THREE BATCHES",
    )

    bw = int(2.4 * INCH)
    bh = int(1.0 * INCH)
    bgap = int(0.25 * INCH)
    cols = 3
    row_total = cols * bw + (cols - 1) * bgap
    row_left = (content_b.width - row_total) // 2
    row_top = int(0.8 * INCH)

    n_b1 = _node(row_left, row_top, bw, bh,
                 "Batch 1 · Source",
                 "ReadProgram + GetIncludesList\n+ GetInclude × N",
                 EPAMColor.Light_Blue, font_size=12)
    n_b2 = _node(row_left + bw + bgap, row_top, bw, bh,
                 "Batch 2 · Extract",
                 "DDIC tables · CDS views\nZ-namespace identifiers",
                 EPAMColor.Light_Teal, font_size=12)
    n_b3 = _node(row_left + 2 * (bw + bgap), row_top, bw, bh,
                 "Batch 3 · Resolve",
                 "GetTable / GetCds\nDescribeByList (one call)",
                 EPAMColor.Light_Orange, font_size=12)

    prs.add_diagram_canvas(
        content_b,
        DiagramCanvas(
            left=0, top=0,
            width=content_b.width, height=content_b.height - int(1.6 * INCH),
            nodes=[n_b1, n_b2, n_b3],
            connections=[
                _arrow(0, 1, "identifiers"),
                _arrow(1, 2, "deduped set"),
            ],
            border=False,
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content_b,
        Block(
            left=0, bottom=0,
            width=content_b.width, height=int(1.4 * INCH),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Orange,
            text_size=TextSize.SMALL,
            rich_content=[
                ContentParagraph(runs=[
                    TextRun(text="Why this order: ", bold=True),
                    TextRun(text="full code first means we know exactly which "
                                 "identifiers exist before we spend a tool call on them.")]),
                ContentParagraph(runs=[
                    TextRun(text="Rules: ", bold=True),
                    TextRun(text="single-keyword SearchSource only · "
                                 "DescribeByList once over the set · no AND-queries.")]),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — The target
    # ============================================================
    _, content_t = prs.add_default_slide(
        title="Target · ZABER_PRESENTATION_FILES",
        upsubtitle="1 PROG + 3 INCLUDES",
    )

    metrics_h = int(2.0 * INCH)
    prs.add_block_grid(
        content_t,
        BlockGrid(
            left=0, top=0,
            width=content_t.width, height=metrics_h,
            columns=5, gap=GapSize.SMALL,
            style=BlockStyle.HERO_METRIC_ON_TOP,
            auto_color_rotation=False,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      metric_value="69",
                      content="main lines",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Blue,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="3",
                      content="includes · TOP·SS·F01",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Teal,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="4",
                      content="modes · radio group",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Magenta,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="1",
                      content="custom table · ZABER_AUTH",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Orange,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="0",
                      content="AUTHORITY-CHECK",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Red,
                      horizontal_alignment=HorizontalAlignment.CENTER),
            ],
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content_t,
        Block(
            left=0, bottom=0,
            width=content_t.width, height=int(2.0 * INCH),
            style=BlockStyle.SOLID_FILL,
            color=EPAMColor.Light_Gray,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            rich_content=[
                ContentParagraph(runs=[
                    TextRun(text="What it does: ", bold=True),
                    TextRun(text="reads ZABER_AUTH · writes/reads CSV on the "
                                 "workstation · emails the CSV. Educational utility, "
                                 "not production.")]),
                ContentParagraph(runs=[
                    TextRun(text="Modes (selection screen): ", bold=True),
                    TextRun(text="Create · Display · Add user · Delete (mutually exclusive radio buttons)")]),
                ContentParagraph(runs=[
                    TextRun(text="External effects: ", bold=True),
                    TextRun(text="gui_download / gui_upload / file_delete + BCS email · DB read-only.")]),
            ],
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — The result
    # ============================================================
    _, content_r = prs.add_default_slide(
        title="Result · spec covers all 9 sections",
        upsubtitle="CITED · 7 OPEN ITEMS",
    )

    prs.add_block_grid(
        content_r,
        BlockGrid(
            left=0, top=0,
            width=content_r.width, height=int(2.5 * INCH),
            columns=3, gap=GapSize.MEDIUM,
            style=BlockStyle.SOLID_FILL,
            auto_color_rotation=False,
            text_size=TextSize.SMALL,
            margin_preset=BlockMarginPreset.NARROW,
            blocks=[
                Block(left=0, top=0, width=0, height=0,
                      title="What got documented",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Teal,
                      rich_content=[
                          ContentParagraph(text="§1-3: metadata + includes", is_bullet=True),
                          ContentParagraph(text="§4: 7 selection-screen fields", is_bullet=True),
                          ContentParagraph(text="§7: 1 custom table (ZABER_AUTH)", is_bullet=True),
                          ContentParagraph(text="§8: full PERFORM graph + flow", is_bullet=True),
                          ContentParagraph(text="§8.1: file I/O + BCS email", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Empty sections (honest)",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Gray,
                      rich_content=[
                          ContentParagraph(text="§5 standard DDIC: none referenced", is_bullet=True),
                          ContentParagraph(text="§6 CDS views: none referenced", is_bullet=True),
                          ContentParagraph(text="ZABER_AUTH package: [UNKNOWN]", is_bullet=True),
                      ]),
                Block(left=0, top=0, width=0, height=0,
                      title="Open questions (§9)",
                      style=BlockStyle.SOLID_FILL,
                      color=EPAMColor.Light_Orange,
                      rich_content=[
                          ContentParagraph(text="Sender hard-coded", is_bullet=True),
                          ContentParagraph(text="'Add user' uses literal name", is_bullet=True),
                          ContentParagraph(text="No AUTHORITY-CHECK", is_bullet=True),
                          ContentParagraph(text="CSV shape contract unclear", is_bullet=True),
                          ContentParagraph(text="'Display' = uploaded, not live", is_bullet=True),
                      ]),
            ],
        ),
        background=Background.LIGHT,
    )

    prs.add_block(
        content_r,
        Block(
            left=0, bottom=0,
            width=content_r.width, height=int(1.0 * INCH),
            content=(
                "Every claim cites a source line or a metadata field · "
                "no row in the spec without provenance."
            ),
            style=BlockStyle.CALLOUT,
            color=EPAMColor.Light_Blue,
            text_size=TextSize.MEDIUM,
        ),
        background=Background.LIGHT,
    )

    # ============================================================
    # Slide — Outcome
    # ============================================================
    _, content_o = prs.add_default_slide(
        title="What you walk away with",
        upsubtitle="OUTCOMES",
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
                      metric_value="1 spec",
                      content="9 sections · every claim cited",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Teal,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="3",
                      content="batches · source · extract · resolve",
                      style=BlockStyle.HERO_METRIC_ON_TOP,
                      color=EPAMColor.Light_Blue,
                      horizontal_alignment=HorizontalAlignment.CENTER),
                Block(left=0, top=0, width=0, height=0,
                      metric_value="~2 min",
                      content="MCP wall-clock for this target",
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
                    TextRun(text="frame a doc task crisply · plan tool calls per "
                                 "question · verify every claim against source · spot "
                                 "fabrication (missing trace, foreign namespace).")]),
                ContentParagraph(runs=[
                    TextRun(text="What stays yours: ", bold=True),
                    TextRun(text="the verification. AI assembles fast and also "
                                 "fabricates fast — citation discipline is the only protection.")]),
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
