"""GGUF file validation for llama-cpp server preflight."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

GGUF_MAGIC = b"GGUF"
# Absolute minimum; real chat models are much larger. Warn below WARN_BYTES.
MIN_BYTES = 1_000_000  # 1 MiB hard floor (rejects empty / tiny junk)
WARN_BYTES = 50_000_000  # 50 MiB — warn but allow (tiny demos)


@dataclass
class ValidateResult:
    ok: bool
    path: str
    size: int
    reason: str
    warning: Optional[str] = None


def validate_gguf(path: str | Path, *, min_bytes: int = MIN_BYTES) -> ValidateResult:
    p = Path(path)
    display = str(p)
    if not p.exists():
        return ValidateResult(False, display, 0, "File does not exist.")
    if not p.is_file():
        return ValidateResult(False, display, 0, "Path is not a file.")
    name = p.name
    if name.endswith(".part") or name.endswith(".tmp") or name.endswith(".download"):
        return ValidateResult(False, display, p.stat().st_size, "Incomplete download (.part/.tmp).")
    size = p.stat().st_size
    if size <= 0:
        return ValidateResult(False, display, size, "File is empty.")
    if size < min_bytes:
        return ValidateResult(
            False,
            display,
            size,
            f"File too small ({size} bytes). Likely incomplete or corrupt.",
        )
    try:
        with p.open("rb") as f:
            magic = f.read(4)
    except OSError as e:
        return ValidateResult(False, display, size, f"Cannot read file: {e}")
    if magic != GGUF_MAGIC:
        return ValidateResult(
            False,
            display,
            size,
            f"Not a GGUF file (magic={magic!r}, expected GGUF).",
        )
    warning = None
    if size < WARN_BYTES:
        warning = (
            f"File is only {size} bytes — many chat models are 1GB+. "
            "If load fails, re-download a complete GGUF."
        )
    return ValidateResult(True, display, size, "OK", warning)


def env_model_host_path(package_root: Path, model_path_env: str) -> Path:
    """Map Docker MODEL_PATH=/models/foo.gguf to package_root/models/foo.gguf."""
    raw = (model_path_env or "").strip()
    if not raw:
        return package_root / "models" / "model.gguf"
    # Strip /models/ or models/ prefix
    name = raw.replace("\\", "/")
    if name.startswith("/models/"):
        name = name[len("/models/") :]
    elif name.startswith("models/"):
        name = name[len("models/") :]
    elif "/" in name:
        name = name.rsplit("/", 1)[-1]
    return package_root / "models" / name


def read_env_value(env_file: Path, key: str, default: str = "") -> str:
    if not env_file.is_file():
        return default
    for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip('"').strip("'")
    return default


def write_env_value(env_file: Path, key: str, value: str) -> None:
    lines: list[str] = []
    found = False
    if env_file.is_file():
        lines = env_file.read_text(encoding="utf-8", errors="replace").splitlines()
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        k, _, _ = stripped.partition("=")
        if k.strip() == key:
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    env_file.write_text("\n".join(out) + "\n", encoding="utf-8")


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024.0 or unit == "TB":
            if unit == "B":
                return f"{int(size)} B"
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{n} B"
