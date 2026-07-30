"""Resumable HTTP downloads for GGUF (and related) files."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from gguf_validate import human_size, validate_gguf

USER_AGENT = "PocketMind-llama-admin/1.1"


def format_mb(n: Optional[int]) -> str:
    if n is None or n < 0:
        return "?"
    mb = n / (1024 * 1024)
    if mb >= 1024:
        return f"{mb / 1024:.2f} GB"
    return f"{mb:.1f} MB"


def _open_url(url: str, headers: dict[str, str], timeout: int = 120):
    req = urllib.request.Request(url, headers=headers)
    return urllib.request.urlopen(req, timeout=timeout)


def download_resumable(
    url: str,
    dest: Path,
    *,
    state: dict[str, Any],
    cancel_event: Optional[threading.Event] = None,
    chunk_size: int = 1024 * 1024,
    validate: bool = True,
    purge_on_cancel: bool = False,
) -> None:
    """
    Download url -> dest using .part + HTTP Range resume.
    On crash/network error the .part file is KEPT so the next call can continue.
    On user cancel with purge_on_cancel=True, the .part (and dest) are deleted.
    """
    part = Path(str(dest) + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)

    existing = part.stat().st_size if part.is_file() else 0
    headers = {"User-Agent": USER_AGENT}
    if existing > 0:
        headers["Range"] = f"bytes={existing}-"

    state.update(
        {
            "active": True,
            "done": False,
            "error": None,
            "url": url,
            "filename": dest.name,
            "bytes": existing,
            "total": state.get("total"),
            "resumed_from": existing if existing > 0 else 0,
            "bytes_human": format_mb(existing),
            "total_human": format_mb(state.get("total")) if state.get("total") else None,
            "percent": None,
        }
    )

    try:
        with _open_url(url, headers) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            # If server ignored Range and returned 200, restart cleanly.
            if existing > 0 and status == 200:
                existing = 0
                mode = "wb"
                state["resumed_from"] = 0
                state["bytes"] = 0
            else:
                mode = "ab" if existing > 0 else "wb"

            total: Optional[int] = None
            cr = resp.headers.get("Content-Range")  # bytes start-end/total
            if cr and "/" in cr:
                try:
                    total = int(cr.rsplit("/", 1)[-1])
                except ValueError:
                    total = None
            if total is None:
                cl = resp.headers.get("Content-Length")
                if cl and cl.isdigit():
                    rem = int(cl)
                    total = existing + rem if mode == "ab" else rem

            state["total"] = total
            state["total_human"] = format_mb(total)

            with part.open(mode) as out:
                while True:
                    if cancel_event is not None and cancel_event.is_set():
                        raise RuntimeError("Download cancelled by user")
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    cur = part.stat().st_size
                    state["bytes"] = cur
                    state["bytes_human"] = format_mb(cur)
                    if total and total > 0:
                        state["percent"] = round(100.0 * cur / total, 1)

        # Finished this file
        if validate and dest.suffix.lower() == ".gguf":
            v = validate_gguf(part)
            if not v.ok:
                # Keep .part for inspection but surface error — do not delete multi-GB data lightly.
                # Only delete if tiny (< 1MB) clear junk.
                if part.stat().st_size < 1_000_000:
                    part.unlink(missing_ok=True)
                raise RuntimeError(f"Download finished but file invalid: {v.reason}")

        if dest.exists():
            dest.unlink()
        part.rename(dest)
        state["bytes"] = dest.stat().st_size
        state["bytes_human"] = format_mb(state["bytes"])
        if state.get("total"):
            state["percent"] = 100.0
    except Exception as e:
        cancelled = cancel_event is not None and cancel_event.is_set()
        if cancelled and purge_on_cancel:
            for path in (part, dest):
                try:
                    if path.is_file():
                        path.unlink()
                except OSError:
                    pass
            state["bytes"] = 0
            state["bytes_human"] = format_mb(0)
            raise RuntimeError("Download cancelled by user") from e
        # Preserve .part for resume on crash/network errors
        if part.is_file():
            state["bytes"] = part.stat().st_size
            state["bytes_human"] = format_mb(state["bytes"])
        raise


def load_catalog(catalog_path: Path) -> dict[str, Any]:
    if not catalog_path.is_file():
        return {"version": 1, "models": []}
    raw = catalog_path.read_bytes()
    # Tolerate UTF-16 from accidental PowerShell redirection
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        text = raw.decode("utf-16")
    else:
        text = raw.decode("utf-8-sig")
    return json.loads(text)


def catalog_model(catalog: dict[str, Any], model_id: str) -> Optional[dict[str, Any]]:
    for m in catalog.get("models") or []:
        if m.get("id") == model_id:
            return m
    return None


def all_urls_for_model(m: dict[str, Any]) -> list[tuple[str, str]]:
    """Return list of (filename, url) including shards and optional mmproj."""
    out: list[tuple[str, str]] = []
    url = (m.get("url") or "").strip()
    if not url:
        return out
    primary = url.split("?", 1)[0].rstrip("/").split("/")[-1]
    out.append((primary, url))
    for u in m.get("shardUrls") or []:
        u = (u or "").strip()
        if not u:
            continue
        name = u.split("?", 1)[0].rstrip("/").split("/")[-1]
        out.append((name, u))
    mm = (m.get("mmprojUrl") or "").strip()
    if mm:
        name = mm.split("?", 1)[0].rstrip("/").split("/")[-1]
        out.append((name, mm))
    return out
