"""Import local host GGUF files into the server package models/ folder."""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional

from gguf_validate import human_size, validate_gguf

SHARD_RE = re.compile(
    r"^(?P<prefix>.+?)(?:-split)?-(?P<idx>\d+)-of-(?P<total>\d+)\.gguf$",
    re.IGNORECASE,
)


def sibling_shard_paths(primary: Path) -> list[Path]:
    """Return all shard files in the same folder (including primary), sorted."""
    m = SHARD_RE.match(primary.name)
    if not m:
        return [primary]
    prefix = m.group("prefix")
    total = int(m.group("total"))
    found: list[Path] = []
    for p in primary.parent.iterdir():
        if not p.is_file():
            continue
        mm = SHARD_RE.match(p.name)
        if not mm:
            continue
        if mm.group("prefix") != prefix:
            continue
        if int(mm.group("total")) != total:
            continue
        found.append(p)
    found.sort(key=lambda x: x.name.lower())
    return found or [primary]


def find_nearby_mmproj(primary: Path) -> Optional[Path]:
    """Best-effort mmproj next to a VL GGUF."""
    parent = primary.parent
    stem = primary.stem
    # Prefer exact-ish names first
    candidates = [
        parent / f"mmproj-{stem}-f16.gguf",
        parent / f"mmproj-{stem}.gguf",
        parent / "mmproj-F16.gguf",
        parent / "mmproj-f16.gguf",
        parent / "mmproj.gguf",
    ]
    for c in candidates:
        if c.is_file():
            return c
    # Any mmproj*.gguf in folder
    hits = sorted(
        [
            p
            for p in parent.iterdir()
            if p.is_file() and p.name.lower().startswith("mmproj") and p.suffix.lower() == ".gguf"
        ],
        key=lambda p: p.name.lower(),
    )
    return hits[0] if hits else None


def _link_or_copy(src: Path, dest: Path) -> str:
    """
    Place src at dest for Docker (./models mount).
    Prefer hardlink (no extra disk), then copy. Symlinks often break inside Docker.
    Returns method: 'exists' | 'hardlink' | 'copy'
    """
    if dest.exists():
        try:
            if dest.samefile(src):
                return "exists"
        except OSError:
            pass
        # Same name already present — reuse if valid size matches
        if dest.stat().st_size == src.stat().st_size:
            return "exists"
        raise FileExistsError(
            f"Destination already exists with different content: {dest.name}. "
            "Rename or delete it in models\\ first."
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dest)
        return "hardlink"
    except OSError:
        shutil.copy2(src, dest)
        return "copy"


def import_local_model(
    source_path: str | Path,
    models_dir: Path,
    *,
    include_shards: bool = True,
    include_mmproj: bool = True,
) -> dict[str, Any]:
    """
    Validate a host GGUF and place it ( + shards / mmproj ) under models_dir.
    Returns primary filename and import details.
    """
    src = Path(source_path).expanduser()
    # Normalize Windows long-path / relative
    try:
        src = src.resolve(strict=False)
    except OSError:
        pass

    v = validate_gguf(src)
    if not v.ok:
        raise ValueError(f"Cannot import: {v.reason} ({src})")

    # If already inside models_dir, just use it
    try:
        src_rel = src.resolve().relative_to(models_dir.resolve())
        already_in = True
        primary_name = src_rel.name if src_rel.parent == Path(".") else src.name
        # Prefer basename when nested unexpectedly
        if src.parent.resolve() == models_dir.resolve():
            primary_name = src.name
    except ValueError:
        already_in = False
        primary_name = src.name

    imported: list[dict[str, Any]] = []
    files: list[Path] = [src]
    if include_shards:
        files = sibling_shard_paths(src)
    if include_mmproj:
        mm = find_nearby_mmproj(src)
        if mm and mm not in files:
            files.append(mm)

    primary_dest_name = src.name
    for f in files:
        dest = models_dir / f.name
        if already_in and f.parent.resolve() == models_dir.resolve():
            method = "exists"
        else:
            method = _link_or_copy(f, dest)
        fv = validate_gguf(dest) if dest.suffix.lower() == ".gguf" else None
        imported.append(
            {
                "source": str(f),
                "filename": dest.name,
                "method": method,
                "size": dest.stat().st_size if dest.is_file() else 0,
                "size_human": human_size(dest.stat().st_size) if dest.is_file() else "0 B",
                "valid": True if fv is None else fv.ok,
                "reason": None if fv is None else fv.reason,
            }
        )
        if f.resolve() == src.resolve():
            primary_dest_name = dest.name

    return {
        "ok": True,
        "primary": primary_dest_name,
        "imported": imported,
        "warning": v.warning,
        "message": (
            f"Imported {len(imported)} file(s). Primary: {primary_dest_name}. "
            "Select & Start to serve it."
        ),
    }


def scan_folder_for_ggufs(folder: str | Path, *, limit: int = 200) -> list[dict[str, Any]]:
    """List .gguf files in a folder (non-recursive by default, + one level)."""
    root = Path(folder).expanduser()
    try:
        root = root.resolve(strict=False)
    except OSError:
        pass
    if not root.is_dir():
        raise ValueError(f"Not a directory: {root}")

    rows: list[dict[str, Any]] = []
    candidates: list[Path] = []
    for p in root.iterdir():
        if p.is_file() and p.suffix.lower() == ".gguf":
            candidates.append(p)
        elif p.is_dir():
            for c in p.iterdir():
                if c.is_file() and c.suffix.lower() == ".gguf":
                    candidates.append(c)
        if len(candidates) >= limit:
            break

    for p in sorted(candidates, key=lambda x: x.name.lower())[:limit]:
        if p.name.endswith(".part"):
            continue
        v = validate_gguf(p)
        rows.append(
            {
                "path": str(p),
                "filename": p.name,
                "size": v.size,
                "size_human": human_size(v.size),
                "valid": v.ok,
                "reason": v.reason,
                "warning": v.warning,
            }
        )
    return rows
