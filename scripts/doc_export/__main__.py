#!/usr/bin/env python3
"""CLI: python -m doc_export --format docx|pptx|pdf --output PATH [--spec PATH|-]

Reads DocSpec JSON from --spec file or stdin (-). Writes Office/PDF binary.
Stdout: single JSON status object.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow running as scripts/doc_export/__main__.py from repo root
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    raise SystemExit(code)


def load_spec(path: str) -> dict:
    if path == "-" or not path:
        raw = sys.stdin.read()
    else:
        raw = Path(path).read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("DocSpec must be a JSON object")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="PocketMind DocSpec exporter")
    parser.add_argument("--format", choices=["docx", "pptx", "pdf"], required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--spec", default="-", help="Path to DocSpec JSON, or - for stdin")
    args = parser.parse_args()

    try:
        spec = load_spec(args.spec)
    except Exception as e:
        emit({"ok": False, "error": f"Invalid DocSpec: {e}"}, 2)

    fmt = args.format
    if not spec.get("format"):
        spec["format"] = fmt
    out = Path(args.output)

    try:
        if fmt == "docx":
            try:
                from doc_export.export_docx import export_docx
            except ImportError:
                from export_docx import export_docx  # type: ignore

            export_docx(spec, out)
        elif fmt == "pptx":
            try:
                from doc_export.export_pptx import export_pptx
            except ImportError:
                from export_pptx import export_pptx  # type: ignore

            export_pptx(spec, out)
        else:
            try:
                from doc_export.export_pdf import export_pdf
            except ImportError:
                from export_pdf import export_pdf  # type: ignore

            export_pdf(spec, out)
    except ImportError as e:
        emit(
            {
                "ok": False,
                "error": (
                    f"Missing Python package for {fmt}: {e}. "
                    "Install: pip install python-docx python-pptx reportlab"
                ),
            },
            3,
        )
    except Exception as e:
        emit({"ok": False, "error": str(e)}, 4)

    if not out.is_file() or out.stat().st_size <= 0:
        emit({"ok": False, "error": "Exporter produced no output file"}, 5)

    emit(
        {
            "ok": True,
            "format": fmt,
            "path": str(out.resolve()),
            "bytes": out.stat().st_size,
            "title": spec.get("title") or "",
        }
    )


if __name__ == "__main__":
    main()
