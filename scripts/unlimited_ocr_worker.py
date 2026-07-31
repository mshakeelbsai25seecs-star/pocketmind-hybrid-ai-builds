#!/usr/bin/env python3
"""PocketMind Unlimited-OCR sidecar (optional high-accuracy offline OCR).

Commands:
  python unlimited_ocr_worker.py probe --model-dir DIR
  python unlimited_ocr_worker.py download --model-dir DIR [--repo baidu/Unlimited-OCR]
  python unlimited_ocr_worker.py ocr --input PATH --output OUT.md --model-dir DIR
       [--mode gundam|base] [--max-pages N]

Stdout is always a single JSON object. Exit 0 on success.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


def emit(payload: dict, code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    raise SystemExit(code)


def model_ready(model_dir: Path) -> bool:
    if not model_dir.is_dir():
        return False
    # HF cache or snapshot usually has config.json
    if (model_dir / "config.json").is_file():
        return True
    # Sometimes nested snapshots/
    for p in model_dir.rglob("config.json"):
        if p.is_file():
            return True
    return False


def resolve_model_path(model_dir: Path) -> str:
    if (model_dir / "config.json").is_file():
        return str(model_dir)
    for p in sorted(model_dir.rglob("config.json")):
        return str(p.parent)
    return str(model_dir)


def cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def resolve_device() -> str:
    """auto → cuda if present else cpu. Override with NEXUS_UNLIMITED_OCR_DEVICE=cpu|cuda|auto."""
    raw = (os.environ.get("NEXUS_UNLIMITED_OCR_DEVICE") or "auto").strip().lower()
    if raw in {"cpu", "cuda"}:
        if raw == "cuda" and not cuda_available():
            return "cpu"
        return raw
    return "cuda" if cuda_available() else "cpu"


def cmd_probe(model_dir: Path) -> None:
    torch_ok = False
    transformers_ok = False
    pymupdf_ok = False
    err = None
    try:
        import torch  # noqa: F401

        torch_ok = True
    except Exception as e:
        err = f"torch: {e}"
    try:
        import transformers  # noqa: F401

        transformers_ok = True
    except Exception as e:
        err = (err + "; " if err else "") + f"transformers: {e}"
    try:
        import fitz  # noqa: F401

        pymupdf_ok = True
    except Exception as e:
        err = (err + "; " if err else "") + f"pymupdf: {e}"

    ready = model_ready(model_dir)
    cuda = cuda_available() if torch_ok else False
    device = resolve_device() if torch_ok else "none"
    warn = err
    if torch_ok and transformers_ok and ready and not cuda:
        note = "Running Unlimited-OCR on CPU (slower). Set NEXUS_UNLIMITED_OCR_DEVICE=cpu to force."
        warn = f"{warn}; {note}" if warn else note
    emit(
        {
            "ok": True,
            "python": sys.executable,
            "torch": torch_ok,
            "transformers": transformers_ok,
            "pymupdf": pymupdf_ok,
            "cuda": cuda,
            "device": device,
            "model_dir": str(model_dir),
            "model_ready": ready,
            # CUDA preferred but not required — CPU works with torch CPU builds.
            "available": torch_ok and transformers_ok and ready,
            "warning": warn,
        }
    )


def cmd_download(model_dir: Path, repo: str) -> None:
    model_dir.mkdir(parents=True, exist_ok=True)
    try:
        from huggingface_hub import snapshot_download
    except Exception as e:
        emit({"ok": False, "error": f"huggingface_hub required: {e}"}, 2)

    try:
        path = snapshot_download(
            repo_id=repo,
            local_dir=str(model_dir),
            local_dir_use_symlinks=False,
            resume_download=True,
        )
        emit(
            {
                "ok": True,
                "model_dir": path,
                "model_ready": model_ready(Path(path)),
                "repo": repo,
            }
        )
    except Exception as e:
        emit({"ok": False, "error": str(e)}, 3)


def pdf_to_images(pdf_path: Path, dpi: int, max_pages: int | None) -> list[Path]:
    import fitz

    doc = fitz.open(pdf_path)
    tmp_dir = Path(tempfile.mkdtemp(prefix="pm_uo_pdf_"))
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    paths: list[Path] = []
    try:
        for i, page in enumerate(doc):
            if max_pages is not None and i >= max_pages:
                break
            out = tmp_dir / f"page_{i + 1:04d}.png"
            page.get_pixmap(matrix=mat).save(str(out))
            paths.append(out)
    finally:
        doc.close()
    return paths


def strip_det_markers(raw: str) -> str:
    import re

    det_re = re.compile(
        r"<\|det\|>([^<\s]+)(?:\s*\[[^\]]*\])?\s*<\|/det\|>(.*)", re.DOTALL
    )
    blocks = []
    cur = None
    for line in raw.splitlines():
        line = line.rstrip()
        if not line:
            continue
        m = det_re.match(line)
        if m:
            category, content = m.group(1).strip(), m.group(2).strip()
            if category == "image":
                continue
            if cur is not None:
                blocks.append(cur)
            cur = [content] if content else []
            continue
        if cur is None:
            cur = []
        cur.append(line)
    if cur is not None:
        blocks.append(cur)
    return "\n\n".join("\n".join(b) for b in blocks).strip()


def collect_text_from_output(output_path: Path) -> str:
    if output_path.is_file():
        return output_path.read_text(encoding="utf-8", errors="replace")
    # Model may write multiple files under a directory
    if output_path.is_dir():
        parts = []
        for p in sorted(output_path.rglob("*")):
            if p.is_file() and p.suffix.lower() in {".md", ".txt", ".mmd", ".json"}:
                try:
                    parts.append(p.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    pass
        return "\n\n".join(parts)
    return ""


def cmd_ocr(
    input_path: Path,
    output_md: Path,
    model_dir: Path,
    mode: str,
    max_pages: int | None,
    dpi: int,
) -> None:
    if not input_path.is_file():
        emit({"ok": False, "error": f"Input not found: {input_path}"}, 4)
    if not model_ready(model_dir):
        emit(
            {
                "ok": False,
                "error": f"Unlimited-OCR weights not found in {model_dir}. Run download first.",
            },
            5,
        )

    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
    except Exception as e:
        emit({"ok": False, "error": f"Missing deps: {e}"}, 7)

    device = resolve_device()
    # bfloat16 is for CUDA; CPU path uses float32 for broader compatibility.
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    model_name = resolve_model_path(model_dir)
    work_dir = Path(tempfile.mkdtemp(prefix="pm_uo_out_"))
    try:
        tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
        model = AutoModel.from_pretrained(
            model_name,
            trust_remote_code=True,
            use_safetensors=True,
            torch_dtype=dtype,
        )
        model = model.eval().to(device)

        ext = input_path.suffix.lower()
        if ext == ".pdf":
            images = pdf_to_images(input_path, dpi=dpi, max_pages=max_pages)
            if not images:
                emit({"ok": False, "error": "PDF produced no pages"}, 8)
            model.infer_multi(
                tokenizer,
                prompt="<image>Multi page parsing.",
                image_files=[str(p) for p in images],
                output_path=str(work_dir),
                image_size=1024,
                max_length=32768,
                no_repeat_ngram_size=35,
                ngram_window=1024,
                save_results=True,
            )
            pages = len(images)
        else:
            # gundam vs base
            if mode == "base":
                base_size, image_size, crop_mode = 1024, 1024, False
            else:
                base_size, image_size, crop_mode = 1024, 640, True
            model.infer(
                tokenizer,
                prompt="<image>document parsing.",
                image_file=str(input_path),
                output_path=str(work_dir),
                base_size=base_size,
                image_size=image_size,
                crop_mode=crop_mode,
                max_length=32768,
                no_repeat_ngram_size=35,
                ngram_window=128,
                save_results=True,
            )
            pages = 1

        raw = collect_text_from_output(work_dir)
        text = strip_det_markers(raw) if raw else raw
        if not text.strip():
            # Fallback: concatenate any text-like artifacts
            text = raw
        if not text.strip():
            emit({"ok": False, "error": "Unlimited-OCR returned empty text"}, 9)

        output_md.parent.mkdir(parents=True, exist_ok=True)
        header = (
            f"# OCR: {input_path.name}\n\n"
            f"Source: {input_path}\n"
            f"Engine: unlimited-ocr\n"
            f"Device: {device}\n"
            f"Pages: {pages}\n\n"
        )
        output_md.write_text(header + text.strip() + "\n", encoding="utf-8")
        emit(
            {
                "ok": True,
                "engine": "unlimited-ocr",
                "device": device,
                "output": str(output_md),
                "pages": pages,
                "chars": len(text),
            }
        )
    except Exception as e:
        emit({"ok": False, "error": str(e)}, 10)


def main() -> None:
    parser = argparse.ArgumentParser(description="PocketMind Unlimited-OCR worker")
    parser.add_argument("command", choices=["probe", "download", "ocr"])
    parser.add_argument(
        "--model-dir",
        default=os.environ.get("NEXUS_UNLIMITED_OCR_DIR", ""),
        help="Local model cache directory",
    )
    parser.add_argument("--repo", default="baidu/Unlimited-OCR")
    parser.add_argument("--input", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--mode", choices=["gundam", "base"], default="gundam")
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--dpi", type=int, default=200)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).expanduser() if args.model_dir else Path("unlimited-ocr")
    if args.command == "probe":
        cmd_probe(model_dir)
    elif args.command == "download":
        cmd_download(model_dir, args.repo)
    else:
        if not args.input or not args.output:
            emit({"ok": False, "error": "--input and --output required for ocr"}, 1)
        cmd_ocr(
            Path(args.input),
            Path(args.output),
            model_dir,
            args.mode,
            args.max_pages,
            args.dpi,
        )


if __name__ == "__main__":
    main()
