"""Automatic GPU/CPU layer planner for llama.cpp Docker server.

Mirrors PocketMind desktop optimizer goals:
  1) Prefer full GPU offload when the model fits free VRAM
  2) Otherwise offload as many layers as possible; rest stay on CPU/RAM
  3) On OOM / crash, step down layers (and optionally context) then retry
  4) Last resort: CPU-only compose
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

from gguf_validate import env_model_host_path, human_size, read_env_value, write_env_value

SHARD_RE = re.compile(
    r"^(?P<prefix>.+?)(?:-split)?-(?P<idx>\d{5})-of-(?P<total>\d{5})\.gguf$",
    re.IGNORECASE,
)
SHARD_RE_LOOSE = re.compile(
    r"^(?P<prefix>.+?)(?:-split)?-(?P<idx>\d+)-of-(?P<total>\d+)\.gguf$",
    re.IGNORECASE,
)


@dataclass
class GpuInfo:
    name: str
    total_bytes: int
    used_bytes: int
    free_bytes: int


@dataclass
class OptimizePlan:
    mode: str  # cuda | cpu
    gpu_layers: int  # -1 = all, 0 = CPU layers, or N
    context_size: int
    model_bytes: int
    model_bytes_human: str
    free_vram_bytes: int
    free_vram_human: str
    total_vram_bytes: int
    estimated_layers: int
    strategy: str
    attempts: list[int] = field(default_factory=list)
    gpu_name: str = ""
    auto: bool = True
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _run(args: list[str], timeout: int = 15) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", f"not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"


def probe_gpus() -> list[GpuInfo]:
    """Query nvidia-smi for free/total VRAM (bytes)."""
    code, out, _ = _run(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.used",
            "--format=csv,noheader,nounits",
        ],
        timeout=10,
    )
    if code != 0 or not out.strip():
        return []
    gpus: list[GpuInfo] = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        try:
            total_mib = int(float(parts[1]))
            used_mib = int(float(parts[2]))
        except ValueError:
            continue
        total = total_mib * 1024 * 1024
        used = used_mib * 1024 * 1024
        gpus.append(
            GpuInfo(
                name=parts[0],
                total_bytes=total,
                used_bytes=used,
                free_bytes=max(0, total - used),
            )
        )
    return gpus


def model_total_bytes(primary: Path) -> int:
    """Sum primary GGUF + sibling shards when multi-part."""
    if not primary.is_file():
        return 0
    name = primary.name
    m = SHARD_RE.match(name) or SHARD_RE_LOOSE.match(name)
    if not m:
        return primary.stat().st_size
    prefix = m.group("prefix")
    total = int(m.group("total"))
    parent = primary.parent
    size = 0
    found = 0
    for p in parent.iterdir():
        if not p.is_file():
            continue
        mm = SHARD_RE.match(p.name) or SHARD_RE_LOOSE.match(p.name)
        if not mm:
            continue
        if mm.group("prefix") != prefix:
            continue
        if int(mm.group("total")) != total:
            continue
        size += p.stat().st_size
        found += 1
    if found == 0:
        return primary.stat().st_size
    return size


def estimate_layer_count(model_size_bytes: int) -> int:
    gb = model_size_bytes / 1_073_741_824.0
    if gb <= 3.0:
        return 32
    if gb <= 6.0:
        return 40
    if gb <= 12.0:
        return 48
    if gb <= 24.0:
        return 64
    if gb <= 42.0:
        return 80
    if gb <= 70.0:
        return 96
    if gb <= 110.0:
        return 120
    return 160


def estimate_partial_gpu_layers(model_size_bytes: int, free_vram_bytes: int) -> int:
    """
    How many layers fit in free VRAM (with KV-cache reserve).
    Returns -1 when the whole model fits (full offload), 0 when nothing fits.
    """
    if model_size_bytes <= 0 or free_vram_bytes <= 0:
        return 0

    two_gb = 2 * 1024 * 1024 * 1024
    one_half_gb = int(1.5 * 1024 * 1024 * 1024)
    if free_vram_bytes > two_gb + one_half_gb:
        usable = free_vram_bytes - two_gb
    elif free_vram_bytes > one_half_gb:
        usable = free_vram_bytes - one_half_gb
    else:
        usable = int(free_vram_bytes * 0.70)

    if usable >= int(model_size_bytes * 1.12):
        return -1

    total_layers = estimate_layer_count(model_size_bytes)
    ratio = max(0.0, min(0.95, usable / float(model_size_bytes)))
    layers = int(total_layers * ratio * 0.94)
    return max(0, min(layers, total_layers - 1))


def unique_descending(values: list[int]) -> list[int]:
    """Keep unique layer attempts, highest GPU first. -1 sorts as highest."""
    seen: set[int] = set()
    out: list[int] = []

    def sort_key(v: int) -> tuple[int, int]:
        if v < 0:
            return (0, 0)
        return (1, -v)

    for v in sorted(values, key=sort_key):
        if v in seen or v < -1:
            continue
        seen.add(v)
        out.append(v)
    return out


def build_attempts(partial: int) -> list[int]:
    """GPU-maximizing attempt ladder."""
    if partial < 0:
        return unique_descending([-1, 120, 96, 80, 64, 48, 32, 0])
    if partial == 0:
        return [0]
    return unique_descending(
        [
            partial,
            int(partial * 0.90),
            int(partial * 0.75),
            int(partial * 0.55),
            int(partial * 0.35),
            min(24, partial),
            min(16, partial),
            min(8, partial),
            0,
        ]
    )


def recommend_context(model_bytes: int, free_vram: int, current_ctx: int, full_fit: bool) -> int:
    """Keep as much context as practical without starving weight offload."""
    cur = max(512, current_ctx)
    if full_fit:
        return cur
    gb = model_bytes / 1_073_741_824.0
    free_gb = free_vram / 1_073_741_824.0
    if gb >= 20 and free_gb < 16:
        return min(cur, 4096)
    if gb >= 12 and free_gb < 12:
        return min(cur, 4096)
    if free_gb < 8:
        return min(cur, 2048)
    return cur


def parse_gpu_layers_setting(raw: str) -> tuple[bool, Optional[int]]:
    """Returns (auto, fixed_layers)."""
    s = (raw or "").strip().lower()
    if s in {"", "auto", "-1"}:
        return True, None
    try:
        n = int(s)
    except ValueError:
        return True, None
    if n >= 0:
        return False, n
    return True, None


def build_plan(
    package_root: Path,
    env_file: Path,
    *,
    force_cpu: bool = False,
) -> OptimizePlan:
    model_env = read_env_value(env_file, "MODEL_PATH", "/models/model.gguf")
    host = env_model_host_path(package_root, model_env)
    model_bytes = model_total_bytes(host)
    if model_bytes <= 0:
        return OptimizePlan(
            mode="cpu",
            gpu_layers=0,
            context_size=int(read_env_value(env_file, "CTX_SIZE", "4096") or "4096"),
            model_bytes=0,
            model_bytes_human="0 B",
            free_vram_bytes=0,
            free_vram_human="0 B",
            total_vram_bytes=0,
            estimated_layers=0,
            strategy="no-model",
            attempts=[0],
            auto=True,
            notes=[
                f"No GGUF at {host}. Import a local .gguf, download from the catalog, "
                "or copy a model into models/ then click Select."
            ],
        )

    try:
        current_ctx = int(read_env_value(env_file, "CTX_SIZE", "4096") or "4096")
    except ValueError:
        current_ctx = 4096

    auto_flag = read_env_value(env_file, "AUTO_OPTIMIZE", "1").strip().lower()
    auto_enabled = auto_flag not in {"0", "false", "no", "off"}
    layers_raw = read_env_value(env_file, "GPU_LAYERS", "-1")
    _want_auto, fixed = parse_gpu_layers_setting(layers_raw)
    # AUTO_OPTIMIZE=1 always re-plans from free VRAM (GPU_LAYERS may hold last applied value).
    # AUTO_OPTIMIZE=0 pins GPU_LAYERS as a manual override.

    gpus = probe_gpus()
    if force_cpu or not gpus:
        notes = ["No NVIDIA GPU detected — using CPU compose."] if not gpus else ["CPU mode requested."]
        return OptimizePlan(
            mode="cpu",
            gpu_layers=0,
            context_size=current_ctx,
            model_bytes=model_bytes,
            model_bytes_human=human_size(model_bytes),
            free_vram_bytes=0,
            free_vram_human="0 B",
            total_vram_bytes=0,
            estimated_layers=estimate_layer_count(model_bytes),
            strategy="cpu-only",
            attempts=[0],
            auto=False,
            notes=notes,
        )

    best = max(gpus, key=lambda g: g.free_bytes)
    free = best.free_bytes
    total = best.total_bytes
    est_layers = estimate_layer_count(model_bytes)

    if (not auto_enabled) and fixed is not None:
        ctx = recommend_context(model_bytes, free, current_ctx, full_fit=False)
        return OptimizePlan(
            mode="cuda",
            gpu_layers=fixed,
            context_size=ctx,
            model_bytes=model_bytes,
            model_bytes_human=human_size(model_bytes),
            free_vram_bytes=free,
            free_vram_human=human_size(free),
            total_vram_bytes=total,
            estimated_layers=est_layers,
            strategy="manual-override",
            attempts=[fixed],
            gpu_name=best.name,
            auto=False,
            notes=[f"Using manual GPU_LAYERS={fixed} (AUTO_OPTIMIZE=0)."],
        )

    partial = estimate_partial_gpu_layers(model_bytes, free)
    full_fit = partial < 0
    ctx = recommend_context(model_bytes, free, current_ctx, full_fit=full_fit)
    attempts = build_attempts(partial)
    primary = attempts[0] if attempts else 0

    if full_fit:
        strategy = "full-gpu"
        notes = [f"{best.name}: model fits free VRAM — full GPU offload (-ngl -1)."]
    elif primary > 0:
        strategy = "split-gpu-cpu"
        notes = [
            f"{best.name}: model larger than free VRAM — offload ~{primary}/{est_layers} layers to GPU, rest on CPU/RAM."
        ]
    else:
        strategy = "cuda-image-cpu-layers"
        notes = [
            f"{best.name}: almost no free VRAM for weights — starting with -ngl 0 on CUDA image."
        ]

    if ctx < current_ctx:
        notes.append(f"CTX_SIZE reduced {current_ctx} → {ctx} to leave VRAM for GPU layers.")

    return OptimizePlan(
        mode="cuda",
        gpu_layers=primary,
        context_size=ctx,
        model_bytes=model_bytes,
        model_bytes_human=human_size(model_bytes),
        free_vram_bytes=free,
        free_vram_human=human_size(free),
        total_vram_bytes=total,
        estimated_layers=est_layers,
        strategy=strategy,
        attempts=attempts,
        gpu_name=best.name,
        auto=True,
        notes=notes,
    )


def apply_plan_to_env(env_file: Path, plan: OptimizePlan) -> None:
    write_env_value(env_file, "GPU_LAYERS", str(plan.gpu_layers))
    write_env_value(env_file, "CTX_SIZE", str(plan.context_size))
    if plan.auto:
        write_env_value(env_file, "AUTO_OPTIMIZE", "1")


def save_plan(package_root: Path, plan: OptimizePlan, extra: Optional[dict[str, Any]] = None) -> Path:
    path = package_root / ".optimizer_plan.json"
    payload = plan.to_dict()
    if extra:
        payload.update(extra)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def load_saved_plan(package_root: Path) -> Optional[dict[str, Any]]:
    path = package_root / ".optimizer_plan.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def looks_like_oom(logs: str) -> bool:
    low = (logs or "").lower()
    needles = [
        "out of memory",
        "cuda error",
        "cuda_error",
        "failed to allocate",
        "oom",
        "insufficient memory",
        "ggml_cuda",
        "cublas",
    ]
    return any(n in low for n in needles)


def ready_timeout_for_model(model_bytes: int) -> int:
    gb = model_bytes / 1_073_741_824.0
    if gb <= 5:
        return 90
    if gb <= 15:
        return 180
    if gb <= 40:
        return 300
    return 420
