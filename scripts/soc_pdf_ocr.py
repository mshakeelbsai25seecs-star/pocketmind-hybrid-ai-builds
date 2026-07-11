#!/usr/bin/env python3
"""Offline SOC PDF OCR helper for Nexus AI.

Requirements (minimum):
  pip install pymupdf pillow winsdk

Optional (often faster on some PDFs):
  pip install pytesseract
  Tesseract OCR on PATH (Windows: winget install UB-Mannheim.TesseractOCR)

Usage:
  python soc_pdf_ocr.py input.pdf [--output output.md] [--max-pages 78] [--dpi 180]
  python soc_pdf_ocr.py --repair-only Policies-OCR.md
"""

from __future__ import annotations

import argparse
import asyncio
import io
import re
import shutil
import sys
import tempfile
from pathlib import Path

DIAGRAM_FRAGMENTATION_THRESHOLD = 0.16
MIN_TOKENS_FOR_FRAGMENTATION = 8
DIAGRAM_PAGE_NOTE = (
    "Visual table-of-contents or diagram page. Full policy text begins on the following pages."
)

COMMON_SHORT = frozenset({
    "a", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it",
    "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we",
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
    "are", "was", "were", "will", "has", "have", "had", "not", "you", "your",
    "our", "their", "there", "can", "may", "all", "any", "each", "both", "data",
    "use", "via", "per", "its", "who", "how", "new", "one", "two", "end", "log",
})


def meaningful(text: str) -> bool:
    return sum(1 for c in text if c.isalpha()) >= 40


def ocr_fragmentation_score(text: str) -> float:
    tokens = text.split()
    if len(tokens) < MIN_TOKENS_FOR_FRAGMENTATION:
        return 0.0
    bad = 0.0
    for index, token in enumerate(tokens):
        core = token.strip(".,;:")
        if len(core) == 1 and core.isalpha() and core.lower() not in ("a", "i"):
            bad += 1.0
        elif (
            len(core) <= 4
            and core
            and core[0].isupper()
            and index + 1 < len(tokens)
        ):
            nxt = tokens[index + 1].strip(".,;:")
            if nxt and nxt[0].islower() and len(nxt) <= 6:
                bad += 0.75
        elif len(core) <= 3 and core.islower():
            bad += 0.5
    return bad / len(tokens)


def _split_token_suffix(token: str) -> tuple[str, str]:
    end = len(token)
    for index in range(len(token) - 1, -1, -1):
        if token[index].isalpha():
            end = index + 1
            break
    return token[:end], token[end:]


def _should_merge_tokens(left: str, right: str) -> bool:
    left_core, _ = _split_token_suffix(left)
    right_core, _ = _split_token_suffix(right)
    if not left_core or not right_core:
        return False
    if not left_core[-1].isalpha() or not right_core[0].isalpha():
        return False
    if left_core.lower() in COMMON_SHORT or right_core.lower() in COMMON_SHORT:
        return False
    if len(right_core) == 1 and right_core.isalpha():
        return right_core.lower() not in ("a", "i")
    if len(left_core) == 1 and left_core.isalpha():
        return left_core.lower() not in ("a", "i")
    if left_core.islower() and right_core.islower():
        return 4 <= len(left_core) <= 5 and 2 <= len(right_core) <= 8
    if (
        len(left_core) <= 4
        and left_core[0].isupper()
        and left_core[1:].islower()
        and right_core.islower()
        and 2 <= len(right_core) <= 8
    ):
        return True
    return False


def merge_split_words_in_line(line: str) -> str:
    tokens = line.split()
    if not tokens:
        return ""
    merged: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        while index + 1 < len(tokens) and _should_merge_tokens(token, tokens[index + 1]):
            index += 1
            next_token = tokens[index]
            core, suffix = _split_token_suffix(next_token)
            if token[-1].isalpha() and core and core[0].islower():
                token = token + core + suffix
            else:
                token = f"{token} {next_token}"
        merged.append(token)
        index += 1
    return " ".join(merged)


def merge_split_words(text: str) -> str:
    return "\n".join(merge_split_words_in_line(line) for line in text.splitlines())


def repair_page_body(body: str) -> str:
    trimmed = body.strip()
    if not trimmed:
        return ""
    if ocr_fragmentation_score(trimmed) >= DIAGRAM_FRAGMENTATION_THRESHOLD:
        return DIAGRAM_PAGE_NOTE
    return merge_split_words(trimmed)


def strip_training_watermarks(text: str) -> str:
    cleaned = text.replace("GENERIC TRAINING copy", "")
    cleaned = cleaned.replace("GENERIC TRAINING", "")
    cleaned = re.sub(r"\s+COPY\b", "", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def repair_ocr_markdown(text: str) -> str:
    normalized = text.replace("\r", "\n")
    out: list[str] = []
    current_page: str | None = None
    body_lines: list[str] = []

    def flush() -> None:
        nonlocal body_lines, current_page
        if current_page is None:
            body_lines.clear()
            return
        raw_body = "\n".join(body_lines).strip()
        body_lines.clear()
        repaired = repair_page_body(raw_body)
        out.append(current_page)
        out.append("")
        out.append(repaired)
        out.append("")

    for line in normalized.splitlines():
        if line.startswith("## Page "):
            flush()
            current_page = line
            continue
        if current_page is not None:
            body_lines.append(line)
        else:
            out.append(line)

    flush()
    return strip_training_watermarks("\n".join(out))


def configure_tesseract() -> bool:
    try:
        import pytesseract
    except ImportError:
        return False

    if shutil.which("tesseract"):
        return True

    for candidate in (
        Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
        Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
    ):
        if candidate.exists():
            pytesseract.pytesseract.tesseract_cmd = str(candidate)
            return True
    return False


def ocr_tesseract_from_pixmap(pix) -> str:
    import pytesseract
    from PIL import Image

    if not configure_tesseract():
        return ""
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    return (pytesseract.image_to_string(img) or "").strip()


def ocr_windows_from_pixmap(pix) -> str:
    from winsdk.windows.graphics.imaging import BitmapDecoder
    from winsdk.windows.media.ocr import OcrEngine
    from winsdk.windows.storage import FileAccessMode, StorageFile

    async def run(path: str) -> str:
        engine = OcrEngine.try_create_from_user_profile_languages()
        if engine is None:
            raise RuntimeError("Windows OCR engine is unavailable on this system.")
        file = await StorageFile.get_file_from_path_async(path)
        stream = await file.open_async(FileAccessMode.READ)
        decoder = await BitmapDecoder.create_async(stream)
        bitmap = await decoder.get_software_bitmap_async()
        result = await engine.recognize_async(bitmap)
        return result.text or ""

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(pix.tobytes("png"))
        temp_path = tmp.name
    try:
        return asyncio.run(run(temp_path)).strip()
    finally:
        Path(temp_path).unlink(missing_ok=True)


def page_text_or_ocr(page, dpi: int) -> str:
    direct = (page.get_text("text") or "").strip()
    if meaningful(direct):
        return direct

    import fitz  # pymupdf

    scale = max(dpi, 72) / 72.0
    matrix = fitz.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=matrix, alpha=False)

    tesseract_text = ""
    try:
        tesseract_text = ocr_tesseract_from_pixmap(pix)
    except Exception:
        tesseract_text = ""
    if meaningful(tesseract_text):
        return tesseract_text

    windows_text = ocr_windows_from_pixmap(pix)
    if meaningful(windows_text):
        return windows_text

    return tesseract_text or windows_text or direct


def ocr_pdf(pdf_path: Path, max_pages: int | None, dpi: int) -> tuple[str, int, int]:
    import fitz

    doc = fitz.open(pdf_path)
    total = len(doc)
    limit = min(total, max_pages) if max_pages else total
    sections: list[str] = []
    ocr_pages = 0

    for index in range(limit):
        page = doc.load_page(index)
        direct = (page.get_text("text") or "").strip()
        if meaningful(direct):
            body = direct
        else:
            body = page_text_or_ocr(page, dpi)
            ocr_pages += 1
        body = repair_page_body(body.strip())
        sections.append(f"## Page {index + 1}\n\n{body}\n")
        print(f"Processed page {index + 1}/{limit}", file=sys.stderr)

    doc.close()
    header = [
        f"# OCR/text extract: {pdf_path.name}",
        "",
        f"Source: {pdf_path}",
        f"Pages processed: {limit} / {total}",
        f"OCR pages: {ocr_pages}",
        "",
    ]
    return "\n".join(header + sections), limit, ocr_pages


def repair_markdown_file(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    return repair_ocr_markdown(text)


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract/OCR a PDF for Nexus SOC knowledge indexing")
    parser.add_argument("pdf", type=Path, nargs="?")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--dpi", type=int, default=180)
    parser.add_argument(
        "--repair-only",
        type=Path,
        default=None,
        help="Repair an existing OCR markdown export without re-running OCR.",
    )
    args = parser.parse_args()

    if args.repair_only:
        if not args.repair_only.exists():
            print(f"ERROR: Markdown file not found: {args.repair_only}", file=sys.stderr)
            return 2
        repaired = repair_markdown_file(args.repair_only)
        out = args.output or args.repair_only
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(repaired, encoding="utf-8")
        print(f"WROTE:{out}")
        print(f"STATS:chars={len(repaired)}", file=sys.stderr)
        return 0

    if args.pdf is None:
        parser.error("input PDF is required unless --repair-only is used")
    if not args.pdf.exists():
        print(f"ERROR: PDF not found: {args.pdf}", file=sys.stderr)
        return 2

    try:
        text, pages, ocr_pages = ocr_pdf(args.pdf, args.max_pages, args.dpi)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    text = strip_training_watermarks(text)
    alpha = sum(1 for c in text if c.isalpha())
    if alpha < 80:
        print("ERROR: OCR produced very little text. Check PDF quality and OCR dependencies.", file=sys.stderr)
        return 1

    out = args.output
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"WROTE:{out}")
    else:
        print(text)

    print(f"STATS:pages={pages};ocr_pages={ocr_pages};chars={len(text)};alpha={alpha}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
