#!/usr/bin/env python3
"""Offline PDF OCR helper for PocketMind Hybrid AI (SOC + Knowledge Chat).

Requirements (minimum):
  pip install pymupdf pillow

Optional:
  pip install pytesseract opencv-python-headless docling
  Tesseract OCR on PATH (Windows: winget install UB-Mannheim.TesseractOCR)
  winsdk (Windows OCR fallback)

Usage:
  python soc_pdf_ocr.py input.pdf [--output out.md] [--engine auto|legacy|docling]
                                  [--preprocess|--no-preprocess] [--dpi 300]
  python soc_pdf_ocr.py --repair-only Policies-OCR.md
"""

from __future__ import annotations

import argparse
import asyncio
import io
import os
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


def light_sanitize_docling(text: str) -> str:
    """Sanitize Docling markdown without aggressive word-merge (preserves tables)."""
    cleaned = strip_training_watermarks(text.replace("\r", "\n"))
    cleaned = re.sub(r"\n{4,}", "\n\n\n", cleaned)
    return cleaned.strip()


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


def preprocess_pil_image(img):
    """Optional OpenCV preprocess: grayscale, binarize, deskew, denoise."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        print("WARNING: OpenCV not installed; skipping preprocess", file=sys.stderr)
        return img

    arr = np.array(img.convert("RGB"))
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    gray = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11
    )
    # Deskew via minAreaRect on non-zero points
    coords = np.column_stack(np.where(binary < 200))
    if coords.size > 100:
        rect = cv2.minAreaRect(coords.astype(np.float32))
        angle = rect[-1]
        if angle < -45:
            angle = 90 + angle
        if abs(angle) > 0.3 and abs(angle) < 15:
            (h, w) = binary.shape[:2]
            center = (w // 2, h // 2)
            m = cv2.getRotationMatrix2D(center, angle, 1.0)
            binary = cv2.warpAffine(
                binary, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
            )
    from PIL import Image

    return Image.fromarray(binary)


def ocr_tesseract_from_pixmap(pix, do_preprocess: bool) -> str:
    import pytesseract
    from PIL import Image

    if not configure_tesseract():
        return ""
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    if do_preprocess:
        img = preprocess_pil_image(img)
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


def page_text_or_ocr(page, dpi: int, do_preprocess: bool) -> str:
    direct = (page.get_text("text") or "").strip()
    if meaningful(direct):
        return direct

    import fitz  # pymupdf

    scale = max(dpi, 72) / 72.0
    matrix = fitz.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=matrix, alpha=False)

    tesseract_text = ""
    try:
        tesseract_text = ocr_tesseract_from_pixmap(pix, do_preprocess)
    except Exception:
        tesseract_text = ""
    if meaningful(tesseract_text):
        return tesseract_text

    try:
        windows_text = ocr_windows_from_pixmap(pix)
    except Exception:
        windows_text = ""
    if meaningful(windows_text):
        return windows_text

    return tesseract_text or windows_text or direct


def ocr_pdf_legacy(
    pdf_path: Path, max_pages: int | None, dpi: int, do_preprocess: bool
) -> tuple[str, int, int]:
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
            body = page_text_or_ocr(page, dpi, do_preprocess)
            ocr_pages += 1
        body = repair_page_body(body.strip())
        sections.append(f"## Page {index + 1}\n\n{body}\n")
        print(f"Processed page {index + 1}/{limit}", file=sys.stderr)

    doc.close()
    header = [
        f"# OCR/text extract: {pdf_path.name}",
        "",
        f"Source: {pdf_path}",
        f"Engine: legacy",
        f"Pages processed: {limit} / {total}",
        f"OCR pages: {ocr_pages}",
        "",
    ]
    return "\n".join(header + sections), limit, ocr_pages


def docling_available() -> bool:
    try:
        import docling  # noqa: F401
        return True
    except Exception:
        return False


def ocr_pdf_docling(pdf_path: Path, max_pages: int | None) -> tuple[str, int, int]:
    """Layout-aware Markdown via Docling; raises on failure for fallback."""
    from docling.document_converter import DocumentConverter

    converter = DocumentConverter()
    result = converter.convert(str(pdf_path))
    md = result.document.export_to_markdown()
    if not md or sum(1 for c in md if c.isalpha()) < 80:
        raise RuntimeError("Docling produced too little text")

    # Best-effort page markers if Docling didn't emit them
    if "## Page " not in md and "# Page " not in md:
        pages = md.count("\n\n") + 1
        wrapped = f"# OCR/text extract: {pdf_path.name}\n\nSource: {pdf_path}\nEngine: docling\n\n{md}\n"
    else:
        wrapped = (
            f"# OCR/text extract: {pdf_path.name}\n\n"
            f"Source: {pdf_path}\nEngine: docling\n\n{md}\n"
        )
    wrapped = light_sanitize_docling(wrapped)
    # Approximate page count from markers or max_pages
    page_hits = len(re.findall(r"^## Page \d+", wrapped, flags=re.M))
    total = page_hits or (max_pages or 1)
    return wrapped, total, total


def unlimited_worker_path() -> Path | None:
    here = Path(__file__).resolve().parent
    candidate = here / "unlimited_ocr_worker.py"
    if candidate.is_file():
        return candidate
    return None


def ocr_pdf_unlimited(pdf_path: Path, output_md: Path, max_pages: int | None) -> tuple[str, int, int]:
    """Delegate to Unlimited-OCR sidecar when CUDA + weights are available."""
    import json
    import subprocess

    worker = unlimited_worker_path()
    if worker is None:
        raise RuntimeError("unlimited_ocr_worker.py not found")

    model_dir = os.environ.get("NEXUS_UNLIMITED_OCR_DIR", "").strip()
    if not model_dir:
        # Best-effort default under common data roots
        for root in (
            os.environ.get("NEXUS_DATA_ROOT", ""),
            str(Path.home() / "AppData" / "Local" / "PocketMind"),
        ):
            if root:
                cand = Path(root) / "models" / "ocr" / "unlimited-ocr"
                if cand.is_dir():
                    model_dir = str(cand)
                    break
    if not model_dir:
        model_dir = str(Path.home() / ".cache" / "pocketmind" / "unlimited-ocr")

    cmd = [
        sys.executable,
        str(worker),
        "ocr",
        "--input",
        str(pdf_path),
        "--output",
        str(output_md),
        "--model-dir",
        model_dir,
        "--mode",
        "gundam",
    ]
    if max_pages is not None:
        cmd.extend(["--max-pages", str(max_pages)])

    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    json_line = next((ln for ln in reversed(stdout.splitlines()) if ln.strip().startswith("{")), "")
    if not json_line:
        raise RuntimeError(stderr or "Unlimited-OCR produced no JSON")
    payload = json.loads(json_line)
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error") or stderr or "Unlimited-OCR failed")
    if not output_md.is_file():
        raise RuntimeError("Unlimited-OCR reported ok but wrote no markdown")
    text = output_md.read_text(encoding="utf-8", errors="replace")
    pages = int(payload.get("pages") or 1)
    return text, pages, pages


def resolve_engine(requested: str) -> str:
    req = (requested or "auto").strip().lower()
    if req == "legacy":
        return "legacy"
    if req in {"unlimited", "unlimited-ocr", "unlimited_ocr"}:
        if unlimited_worker_path() is not None:
            return "unlimited"
        print("WARNING: Unlimited-OCR worker missing; falling back", file=sys.stderr)
        req = "auto"
    if req == "docling":
        if docling_available():
            return "docling"
        print("WARNING: Docling not importable; falling back to legacy", file=sys.stderr)
        return "legacy"
    # auto → docling then legacy (Unlimited is attempted separately in main)
    if docling_available():
        return "docling"
    return "legacy"


def repair_markdown_file(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if "Engine: docling" in text or "|" in text[:2000]:
        return light_sanitize_docling(text)
    return repair_ocr_markdown(text)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract/OCR a PDF for PocketMind Hybrid AI knowledge indexing"
    )
    parser.add_argument("pdf", type=Path, nargs="?")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument(
        "--engine",
        choices=["auto", "legacy", "docling", "unlimited"],
        default="auto",
        help="OCR engine (auto tries Unlimited when ready, then Docling, then legacy)",
    )
    parser.add_argument(
        "--preprocess",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="OpenCV preprocess before Tesseract (legacy path)",
    )
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
        if args.pdf.stat().st_size <= 0:
            print("ERROR: PDF file is empty", file=sys.stderr)
            return 2
    except OSError as exc:
        print(f"ERROR: Cannot read PDF: {exc}", file=sys.stderr)
        return 2

    dpi = args.dpi if isinstance(args.dpi, int) and 72 <= args.dpi <= 600 else 300
    max_pages = args.max_pages
    if max_pages is not None and (not isinstance(max_pages, int) or max_pages < 1):
        max_pages = None

    requested = (args.engine or "auto").strip().lower()
    out_preview = args.output
    engine = resolve_engine(requested)
    print(f"Using engine: {engine} (requested={requested})", file=sys.stderr)

    try:
        text = ""
        pages = 0
        ocr_pages = 0
        # Auto/explicit unlimited: try Unlimited-OCR first, then fall through.
        if requested in {"auto", "unlimited", "unlimited-ocr", "unlimited_ocr"} and unlimited_worker_path():
            try:
                tmp_out = out_preview or (Path(tempfile.mkdtemp(prefix="soc_uo_")) / "ocr.md")
                text, pages, ocr_pages = ocr_pdf_unlimited(args.pdf, Path(tmp_out), max_pages)
                engine = "unlimited"
            except Exception as exc:  # noqa: BLE001
                print(f"WARNING: Unlimited-OCR failed ({exc}); falling back", file=sys.stderr)
                text = ""
                if requested in {"unlimited", "unlimited-ocr", "unlimited_ocr"}:
                    engine = resolve_engine("auto")
                else:
                    engine = resolve_engine("auto") if engine == "unlimited" else engine

        if not text.strip():
            if engine == "docling" or (requested == "auto" and docling_available()):
                try:
                    text, pages, ocr_pages = ocr_pdf_docling(args.pdf, max_pages)
                    engine = "docling"
                except Exception as exc:  # noqa: BLE001
                    print(f"WARNING: Docling failed ({exc}); falling back to legacy", file=sys.stderr)
                    text, pages, ocr_pages = ocr_pdf_legacy(
                        args.pdf, max_pages, dpi, args.preprocess
                    )
                    engine = "legacy"
            else:
                text, pages, ocr_pages = ocr_pdf_legacy(
                    args.pdf, max_pages, dpi, args.preprocess
                )
                engine = "legacy"
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    text = strip_training_watermarks(text)
    alpha = sum(1 for c in text if c.isalpha())
    if alpha < 80:
        print(
            "ERROR: OCR produced very little text. Check PDF quality and OCR dependencies.",
            file=sys.stderr,
        )
        return 1

    out = args.output
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"WROTE:{out}")
    else:
        print(text)

    print(
        f"STATS:pages={pages};ocr_pages={ocr_pages};chars={len(text)};alpha={alpha};engine={engine}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
