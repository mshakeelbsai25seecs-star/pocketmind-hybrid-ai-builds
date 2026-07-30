"""Export DocSpec JSON to PDF via reportlab (fpdf2 fallback)."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def _export_reportlab(spec: dict[str, Any], output_path: Path) -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        ListFlowable,
        ListItem,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.lib import colors

    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(name="DocBody", parent=styles["Normal"], fontSize=11, leading=15)
    )
    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=letter,
        leftMargin=0.85 * inch,
        rightMargin=0.85 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
    )
    story = []
    title = (spec.get("title") or "Document").strip() or "Document"
    story.append(Paragraph(title.replace("&", "&amp;"), styles["Title"]))
    subtitle = (spec.get("subtitle") or "").strip()
    if subtitle:
        story.append(Paragraph(subtitle.replace("&", "&amp;"), styles["Italic"]))
    story.append(Spacer(1, 0.2 * inch))

    def esc(s: str) -> str:
        return (
            s.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\n", "<br/>")
        )

    sections = spec.get("sections") or []
    if not sections and spec.get("body_markdown"):
        sections = [{"heading": "", "body_markdown": spec.get("body_markdown"), "bullets": []}]
    if not sections and spec.get("slides"):
        for slide in spec["slides"]:
            sections.append(
                {
                    "heading": slide.get("title") or "",
                    "body_markdown": "",
                    "bullets": slide.get("bullets") or [],
                }
            )

    for section in sections:
        heading = (section.get("heading") or "").strip()
        if heading:
            story.append(Paragraph(esc(heading), styles["Heading1"]))
        body = (section.get("body_markdown") or section.get("body") or "").strip()
        if body:
            for block in body.split("\n\n"):
                block = block.strip()
                if not block:
                    continue
                if block.startswith("#"):
                    story.append(Paragraph(esc(block.lstrip("# ").strip()), styles["Heading2"]))
                else:
                    story.append(Paragraph(esc(block), styles["DocBody"]))
                    story.append(Spacer(1, 0.08 * inch))
        bullets = [str(b).strip() for b in (section.get("bullets") or []) if str(b).strip()]
        if bullets:
            items = [ListItem(Paragraph(esc(b), styles["DocBody"])) for b in bullets]
            story.append(ListFlowable(items, bulletType="bullet", start="•"))
            story.append(Spacer(1, 0.1 * inch))

        table = section.get("table")
        if isinstance(table, dict) and table.get("headers"):
            data = [list(map(str, table["headers"]))]
            for row in table.get("rows") or []:
                data.append(list(map(str, row)))
            t = Table(data, hAlign="LEFT")
            t.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eef7")),
                        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                        ("FONTSIZE", (0, 0), (-1, -1), 9),
                        ("TOPPADDING", (0, 0), (-1, -1), 4),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                    ]
                )
            )
            story.append(t)
            story.append(Spacer(1, 0.15 * inch))

    for table in spec.get("tables") or []:
        if not isinstance(table, dict) or not table.get("headers"):
            continue
        data = [list(map(str, table["headers"]))]
        for row in table.get("rows") or []:
            data.append(list(map(str, row)))
        t = Table(data, hAlign="LEFT")
        t.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eef7")),
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                ]
            )
        )
        story.append(t)

    if len(story) < 2:
        story.append(Paragraph("(Empty document)", styles["DocBody"]))

    doc.build(story)


def _export_fpdf(spec: dict[str, Any], output_path: Path) -> None:
    from fpdf import FPDF

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    title = (spec.get("title") or "Document").strip() or "Document"
    pdf.multi_cell(0, 10, title)
    pdf.ln(4)
    pdf.set_font("Helvetica", size=11)

    sections = spec.get("sections") or []
    if not sections and spec.get("body_markdown"):
        sections = [{"heading": "", "body_markdown": spec["body_markdown"], "bullets": []}]
    if not sections and spec.get("slides"):
        for slide in spec["slides"]:
            sections.append(
                {
                    "heading": slide.get("title") or "",
                    "bullets": slide.get("bullets") or [],
                }
            )

    for section in sections:
        heading = (section.get("heading") or "").strip()
        if heading:
            pdf.set_font("Helvetica", "B", 13)
            pdf.multi_cell(0, 8, heading)
            pdf.set_font("Helvetica", size=11)
        body = (section.get("body_markdown") or section.get("body") or "").strip()
        if body:
            pdf.multi_cell(0, 6, body)
            pdf.ln(2)
        for bullet in section.get("bullets") or []:
            text = str(bullet).strip()
            if text:
                pdf.multi_cell(0, 6, f"- {text}")
        pdf.ln(3)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(output_path))


def export_pdf(spec: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        _export_reportlab(spec, output_path)
    except Exception:
        _export_fpdf(spec, output_path)
