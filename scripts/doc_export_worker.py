#!/usr/bin/env python3
"""Thin entrypoint for Rust: python scripts/doc_export_worker.py --format docx --output out.docx

Delegates to scripts/doc_export/__main__.py with scripts/ on sys.path.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
runpy.run_path(str(HERE / "doc_export" / "__main__.py"), run_name="__main__")
