"""
PocketMind llama.cpp host admin UI.

Runs on the Windows/Linux host (not inside the GPU container) so it can
manage ./models, .env, and docker compose from the package root.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from gguf_validate import (
    env_model_host_path,
    human_size,
    read_env_value,
    validate_gguf,
    write_env_value,
)
from download_util import (
    all_urls_for_model,
    catalog_model,
    download_resumable,
    format_mb,
    load_catalog,
)
from gpu_optimizer import (
    OptimizePlan,
    apply_plan_to_env,
    build_plan,
    load_saved_plan,
    looks_like_oom,
    ready_timeout_for_model,
    save_plan,
)
from import_util import import_local_model, scan_folder_for_ggufs

ADMIN_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = ADMIN_DIR.parent
MODELS_DIR = PACKAGE_ROOT / "models"
ENV_FILE = PACKAGE_ROOT / ".env"
ENV_EXAMPLE = PACKAGE_ROOT / ".env.example"
TOKEN_FILE = PACKAGE_ROOT / ".admin_token"
STATIC_DIR = ADMIN_DIR / "static"
CATALOG_FILE = ADMIN_DIR / "catalog.json"

CONTAINER_CUDA = "nexusai-llama-cpp-cuda"
CONTAINER_CPU = "nexusai-llama-cpp-cpu"

_download_lock = threading.Lock()
_cancel_event = threading.Event()
_purge_on_cancel = False
_download_job_files: list[Path] = []
# Only files this job created/wrote (not pre-existing skipped models).
_download_touched_files: list[Path] = []
_download_state: dict[str, Any] = {
    "active": False,
    "url": "",
    "filename": "",
    "bytes": 0,
    "total": None,
    "bytes_human": "0 MB",
    "total_human": None,
    "percent": None,
    "error": None,
    "done": False,
    "resumed_from": 0,
    "catalog_id": None,
    "file_index": 0,
    "file_count": 0,
    "message": "",
}


def _note_touched(dest: Path) -> None:
    for path in (dest, Path(str(dest) + ".part")):
        if path not in _download_touched_files:
            _download_touched_files.append(path)


def _purge_job_files(files: Optional[list[Path]] = None) -> list[str]:
    """Delete files this download job wrote (final + .part)."""
    targets = files if files is not None else list(_download_touched_files)
    # Also include declared job destinations' .part files if present.
    if files is None:
        for dest in _download_job_files:
            part = Path(str(dest) + ".part")
            if part not in targets:
                targets.append(part)
            # Only delete final dest if this job touched it (or it is still a .part rename target).
            if dest in _download_touched_files and dest not in targets:
                targets.append(dest)
    removed: list[str] = []
    seen: set[str] = set()
    for path in targets:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        try:
            if path.is_file():
                path.unlink()
                removed.append(path.name)
        except OSError:
            pass
    return removed


def ensure_layout() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if not ENV_FILE.is_file() and ENV_EXAMPLE.is_file():
        ENV_FILE.write_text(ENV_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")


def get_or_create_token() -> str:
    env_tok = os.environ.get("ADMIN_TOKEN", "").strip()
    if env_tok:
        return env_tok
    if TOKEN_FILE.is_file():
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if tok:
            return tok
    tok = secrets.token_urlsafe(24)
    TOKEN_FILE.write_text(tok + "\n", encoding="utf-8")
    return tok


ADMIN_TOKEN = ""


def require_token(authorization: Optional[str] = None, x_admin_token: Optional[str] = None) -> None:
    provided = ""
    if x_admin_token:
        provided = x_admin_token.strip()
    elif authorization:
        auth = authorization.strip()
        if auth.lower().startswith("bearer "):
            provided = auth[7:].strip()
        else:
            provided = auth
    if not provided or provided != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing admin token")


def run_cmd(args: list[str], timeout: int = 120) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            args,
            cwd=str(PACKAGE_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", f"Command not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", "Command timed out"


def docker_compose(compose_file: str, *compose_args: str, timeout: int = 180) -> tuple[int, str, str]:
    return run_cmd(
        ["docker", "compose", "--env-file", ".env", "-f", compose_file, *compose_args],
        timeout=timeout,
    )


def detect_mode() -> str:
    # Prefer cuda if nvidia looks available
    code, out, _ = run_cmd(["nvidia-smi", "-L"], timeout=10)
    if code == 0 and out.strip():
        return "cuda"
    return "cpu"


def compose_file_for(mode: str) -> str:
    return "docker-compose.cuda.yml" if mode == "cuda" else "docker-compose.cpu.yml"


def container_name_for(mode: str) -> str:
    return CONTAINER_CUDA if mode == "cuda" else CONTAINER_CPU


def container_inspect(name: str) -> dict[str, Any]:
    code, out, err = run_cmd(["docker", "inspect", name], timeout=30)
    if code != 0:
        return {"exists": False, "error": (err or out).strip() or "not found"}
    try:
        data = json.loads(out)[0]
    except (json.JSONDecodeError, IndexError, KeyError):
        return {"exists": False, "error": "bad inspect output"}
    state = data.get("State") or {}
    health = (state.get("Health") or {}).get("Status")
    return {
        "exists": True,
        "status": state.get("Status"),
        "running": bool(state.get("Running")),
        "restarting": bool(state.get("Restarting")),
        "exit_code": state.get("ExitCode"),
        "error": state.get("Error") or None,
        "health": health,
        "started_at": state.get("StartedAt"),
    }


def container_logs(name: str, tail: int = 120) -> str:
    code, out, err = run_cmd(["docker", "logs", "--tail", str(tail), name], timeout=30)
    return ((out or "") + "\n" + (err or "")).strip()


def chat_port() -> int:
    try:
        return int(read_env_value(ENV_FILE, "PORT", "8000") or "8000")
    except ValueError:
        return 8000


def wait_chat_ready(mode: str, *, model_bytes: int) -> tuple[bool, str]:
    """Poll until /v1/models answers or the container is clearly failing."""
    name = container_name_for(mode)
    port = chat_port()
    timeout = ready_timeout_for_model(model_bytes)
    deadline = time.time() + timeout
    last = "waiting"
    while time.time() < deadline:
        insp = container_inspect(name)
        if insp.get("restarting"):
            logs = container_logs(name)
            return False, f"container restarting — {logs[-800:]}"
        if insp.get("exists") and not insp.get("running"):
            exit_code = insp.get("exit_code")
            if exit_code not in (None, 0):
                logs = container_logs(name)
                return False, f"container exited ({exit_code}) — {logs[-800:]}"
        probe = probe_models_api(port)
        if probe.get("ok"):
            return True, "ready"
        last = probe.get("error") or insp.get("status") or "not ready"
        # Fail fast on obvious OOM in logs even if still "running"
        if insp.get("running"):
            logs = container_logs(name, tail=60)
            if looks_like_oom(logs):
                return False, f"GPU/CUDA OOM detected — {logs[-800:]}"
        time.sleep(3)
    logs = container_logs(name)
    return False, f"timeout after {timeout}s ({last}) — {logs[-600:]}"


def stop_all_chat_containers() -> None:
    for m in ("cuda", "cpu"):
        docker_compose(compose_file_for(m), "down", timeout=120)


def start_with_optimizer(requested_mode: Optional[str] = None) -> dict[str, Any]:
    """
    Plan GPU layers for maximum utilization, start compose, and step down on OOM.
    """
    force_cpu = (requested_mode or "").lower() == "cpu"
    plan = build_plan(PACKAGE_ROOT, ENV_FILE, force_cpu=force_cpu)
    attempt_log: list[dict[str, Any]] = []

    if plan.mode == "cpu":
        apply_plan_to_env(ENV_FILE, plan)
        stop_all_chat_containers()
        compose = compose_file_for("cpu")
        code, out, err = docker_compose(compose, "up", "-d", timeout=300)
        if code != 0:
            raise HTTPException(500, detail=f"docker compose failed: {err or out}")
        ok, detail = wait_chat_ready("cpu", model_bytes=plan.model_bytes)
        save_plan(
            PACKAGE_ROOT,
            plan,
            extra={"applied_gpu_layers": 0, "ready": ok, "detail": detail, "attempts_log": attempt_log},
        )
        if not ok:
            raise HTTPException(500, detail=f"CPU server failed to become ready: {detail}")
        return {
            "ok": True,
            "mode": "cpu",
            "compose": compose,
            "optimizer": plan.to_dict(),
            "applied_gpu_layers": 0,
            "inspect": container_inspect(CONTAINER_CPU),
            "message": "Started on CPU. " + " ".join(plan.notes),
        }

    attempts = list(plan.attempts) or [plan.gpu_layers]
    last_error = ""
    for layers in attempts:
        trial = OptimizePlan(
            mode="cuda",
            gpu_layers=layers,
            context_size=plan.context_size,
            model_bytes=plan.model_bytes,
            model_bytes_human=plan.model_bytes_human,
            free_vram_bytes=plan.free_vram_bytes,
            free_vram_human=plan.free_vram_human,
            total_vram_bytes=plan.total_vram_bytes,
            estimated_layers=plan.estimated_layers,
            strategy=plan.strategy if layers == plan.gpu_layers else "fallback-stepdown",
            attempts=attempts,
            gpu_name=plan.gpu_name,
            auto=plan.auto,
            notes=list(plan.notes)
            + ([f"Retrying with GPU_LAYERS={layers}"] if layers != plan.gpu_layers else []),
        )
        apply_plan_to_env(ENV_FILE, trial)
        stop_all_chat_containers()
        compose = compose_file_for("cuda")
        code, out, err = docker_compose(compose, "up", "-d", timeout=300)
        if code != 0:
            last_error = err or out
            attempt_log.append({"gpu_layers": layers, "compose_ok": False, "error": last_error[-500:]})
            continue
        ok, detail = wait_chat_ready("cuda", model_bytes=plan.model_bytes)
        attempt_log.append({"gpu_layers": layers, "compose_ok": True, "ready": ok, "detail": detail[-500:]})
        if ok:
            save_plan(
                PACKAGE_ROOT,
                trial,
                extra={
                    "applied_gpu_layers": layers,
                    "ready": True,
                    "detail": detail,
                    "attempts_log": attempt_log,
                },
            )
            ngl_label = "all (-1)" if layers < 0 else str(layers)
            return {
                "ok": True,
                "mode": "cuda",
                "compose": compose,
                "optimizer": trial.to_dict(),
                "applied_gpu_layers": layers,
                "attempts_log": attempt_log,
                "inspect": container_inspect(CONTAINER_CUDA),
                "message": (
                    f"Started with GPU_LAYERS={ngl_label}, CTX_SIZE={trial.context_size}. "
                    + " ".join(trial.notes)
                ),
            }
        last_error = detail
        # Step down — stop before next try
        docker_compose(compose, "down", timeout=120)

    # Last resort: CPU compose
    cpu_plan = build_plan(PACKAGE_ROOT, ENV_FILE, force_cpu=True)
    cpu_plan.notes = [
        "CUDA attempts failed; falling back to CPU compose.",
        f"Last CUDA error: {last_error[-300:]}",
    ] + cpu_plan.notes
    apply_plan_to_env(ENV_FILE, cpu_plan)
    stop_all_chat_containers()
    compose = compose_file_for("cpu")
    code, out, err = docker_compose(compose, "up", "-d", timeout=300)
    if code != 0:
        save_plan(
            PACKAGE_ROOT,
            plan,
            extra={"ready": False, "detail": last_error, "attempts_log": attempt_log},
        )
        raise HTTPException(
            500,
            detail=f"All GPU attempts failed and CPU compose failed. Last GPU error: {last_error}. CPU: {err or out}",
        )
    ok, detail = wait_chat_ready("cpu", model_bytes=plan.model_bytes)
    save_plan(
        PACKAGE_ROOT,
        cpu_plan,
        extra={
            "applied_gpu_layers": 0,
            "ready": ok,
            "detail": detail,
            "attempts_log": attempt_log,
            "fell_back_to_cpu": True,
        },
    )
    if not ok:
        raise HTTPException(500, detail=f"CPU fallback also failed: {detail}")
    return {
        "ok": True,
        "mode": "cpu",
        "compose": compose,
        "optimizer": cpu_plan.to_dict(),
        "applied_gpu_layers": 0,
        "attempts_log": attempt_log,
        "fell_back_to_cpu": True,
        "inspect": container_inspect(CONTAINER_CPU),
        "message": "GPU attempts failed; running on CPU. " + " ".join(cpu_plan.notes),
    }


def probe_models_api(port: int) -> dict[str, Any]:
    url = f"http://127.0.0.1:{port}/v1/models"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return {"ok": True, "status": resp.status, "body_preview": body[:500]}
    except Exception as e:  # noqa: BLE001 — surface any probe failure
        return {"ok": False, "error": str(e)}


def selected_model_info() -> dict[str, Any]:
    model_env = read_env_value(ENV_FILE, "MODEL_PATH", "/models/model.gguf")
    host_path = env_model_host_path(PACKAGE_ROOT, model_env)
    result = validate_gguf(host_path)
    return {
        "model_path_env": model_env,
        "host_path": str(host_path),
        "valid": result.ok,
        "size": result.size,
        "size_human": human_size(result.size) if result.size else "0 B",
        "reason": result.reason,
        "warning": result.warning,
    }


app = FastAPI(title="PocketMind llama.cpp Admin", version="1.0.0")


@app.on_event("startup")
def _startup() -> None:
    global ADMIN_TOKEN
    ensure_layout()
    ADMIN_TOKEN = get_or_create_token()
    print(f"[pocketmind-admin] package root: {PACKAGE_ROOT}")
    print(f"[pocketmind-admin] admin token: {ADMIN_TOKEN}")
    print("[pocketmind-admin] UI: http://127.0.0.1:8090/")


class DownloadBody(BaseModel):
    url: str = Field(..., min_length=8)
    filename: Optional[str] = None


class CatalogDownloadBody(BaseModel):
    id: str = Field(..., min_length=1)
    include_mmproj: bool = True


class SelectBody(BaseModel):
    filename: str = Field(..., min_length=1)


class ImportBody(BaseModel):
    path: str = Field(..., min_length=2)
    include_shards: bool = True
    include_mmproj: bool = True
    select: bool = True


class ScanFolderBody(BaseModel):
    folder: str = Field(..., min_length=2)


class ModeBody(BaseModel):
    mode: Optional[str] = None  # cuda | cpu


def auth(
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> None:
    require_token(authorization, x_admin_token)


@app.get("/api/health")
def api_health() -> dict[str, Any]:
    return {"ok": True, "service": "pocketmind-llama-admin"}


@app.get("/api/bootstrap")
def api_bootstrap() -> dict[str, Any]:
    """Public: tells UI where to put the token; does not leak the token."""
    return {
        "package_root": str(PACKAGE_ROOT),
        "models_dir": str(MODELS_DIR),
        "chat_port": chat_port(),
        "admin_port": int(os.environ.get("ADMIN_PORT", "8090")),
        "token_hint": "Set header X-Admin-Token (printed when start-admin.ps1 runs; also in .admin_token).",
        "has_token_file": TOKEN_FILE.is_file(),
    }


@app.get("/api/status")
def api_status(
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    mode = detect_mode()
    cname = container_name_for(mode)
    # Also check the other container in case operator switched modes
    inspect = container_inspect(cname)
    alt = container_inspect(container_name_for("cpu" if mode == "cuda" else "cuda"))
    port = chat_port()
    return {
        "mode_suggested": mode,
        "container": cname,
        "inspect": inspect,
        "alt_inspect": alt,
        "selected_model": selected_model_info(),
        "chat_api": probe_models_api(port),
        "chat_url_local": f"http://127.0.0.1:{port}/v1",
        "download": dict(_download_state),
        "docker_ok": run_cmd(["docker", "version"], timeout=15)[0] == 0,
        "optimizer": load_saved_plan(PACKAGE_ROOT) or build_plan(PACKAGE_ROOT, ENV_FILE).to_dict(),
        "env_gpu_layers": read_env_value(ENV_FILE, "GPU_LAYERS", "-1"),
        "env_ctx_size": read_env_value(ENV_FILE, "CTX_SIZE", "4096"),
        "auto_optimize": read_env_value(ENV_FILE, "AUTO_OPTIMIZE", "1"),
    }


@app.get("/api/models")
def api_models(
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    ensure_layout()
    rows = []
    partials = []
    for p in sorted(MODELS_DIR.iterdir(), key=lambda x: x.name.lower()):
        if not p.is_file():
            continue
        name = p.name
        if name.endswith(".part"):
            partials.append(
                {
                    "filename": name,
                    "size": p.stat().st_size,
                    "size_human": format_mb(p.stat().st_size),
                    "partial": True,
                    "valid": False,
                    "reason": "Incomplete download — click Download again to resume",
                }
            )
            continue
        if p.suffix.lower() != ".gguf" and ".gguf" not in name.lower():
            continue
        v = validate_gguf(p)
        rows.append(
            {
                "filename": name,
                "size": v.size,
                "size_human": human_size(v.size),
                "partial": False,
                "valid": v.ok,
                "reason": v.reason,
                "warning": v.warning,
            }
        )
    return {"models": rows, "partials": partials, "selected": selected_model_info()}


@app.get("/api/catalog")
def api_catalog(
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    cat = load_catalog(CATALOG_FILE)
    models = []
    for m in cat.get("models") or []:
        urls = all_urls_for_model(m)
        models.append(
            {
                "id": m.get("id"),
                "name": m.get("name"),
                "params": m.get("params"),
                "quant": m.get("quant"),
                "size": m.get("size"),
                "ram": m.get("ram"),
                "categories": m.get("categories") or [],
                "recommendedUse": m.get("recommendedUse"),
                "visionCapable": bool(m.get("visionCapable")),
                "downloadable": bool(urls),
                "file_count": len(urls),
                "has_shards": len(m.get("shardUrls") or []) > 0,
            }
        )
    return {"version": cat.get("version", 1), "models": models}


def _safe_filename(name: str) -> str:
    name = name.strip().replace("\\", "/").split("/")[-1]
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("Invalid filename")
    return name


def _begin_download_job(files: list[tuple[str, str]], *, catalog_id: Optional[str] = None) -> dict[str, Any]:
    """files: list of (filename, url). Resumable on crash; Stop clears files this job wrote."""
    global _download_job_files, _download_touched_files, _purge_on_cancel
    if not files:
        raise HTTPException(400, "No files to download")
    if not _download_lock.acquire(blocking=False):
        raise HTTPException(409, "A download is already in progress")
    if _download_state.get("active"):
        _download_lock.release()
        raise HTTPException(409, "A download is already in progress")

    _cancel_event.clear()
    _purge_on_cancel = False
    job_paths: list[Path] = []
    for filename, _url in files:
        try:
            safe = _safe_filename(filename)
        except ValueError as e:
            _download_lock.release()
            raise HTTPException(400, str(e)) from e
        job_paths.append(MODELS_DIR / safe)
    _download_job_files = list(job_paths)
    _download_touched_files = []

    def worker() -> None:
        global _purge_on_cancel
        try:
            _download_state.update(
                {
                    "active": True,
                    "done": False,
                    "error": None,
                    "catalog_id": catalog_id,
                    "file_count": len(files),
                    "message": "Starting download...",
                }
            )
            primary_gguf: Optional[str] = None
            for idx, (filename, url) in enumerate(files, start=1):
                if _cancel_event.is_set():
                    raise RuntimeError("STOPPED_BY_USER")
                try:
                    safe = _safe_filename(filename)
                except ValueError as e:
                    raise RuntimeError(str(e)) from e
                dest = MODELS_DIR / safe
                if dest.is_file() and (
                    dest.suffix.lower() != ".gguf" or validate_gguf(dest).ok
                ):
                    _download_state["message"] = f"Skipping existing {dest.name}"
                    _download_state["file_index"] = idx
                    if dest.suffix.lower() == ".gguf" and primary_gguf is None:
                        primary_gguf = dest.name
                    continue
                _note_touched(dest)
                _download_state["file_index"] = idx
                _download_state["message"] = f"File {idx}/{len(files)}: {dest.name}"
                download_resumable(
                    url,
                    dest,
                    state=_download_state,
                    cancel_event=_cancel_event,
                    validate=dest.suffix.lower() == ".gguf",
                    purge_on_cancel=True,
                )
                if dest.suffix.lower() == ".gguf" and primary_gguf is None:
                    primary_gguf = dest.name
            if primary_gguf:
                write_env_value(ENV_FILE, "MODEL_PATH", f"/models/{primary_gguf}")
                _download_state["message"] = f"Done. Selected {primary_gguf} in .env"
            else:
                _download_state["message"] = "Done."
            _download_state["active"] = False
            _download_state["done"] = True
            _download_state["percent"] = 100.0
        except Exception as e:  # noqa: BLE001
            stopped = _cancel_event.is_set() or "STOPPED_BY_USER" in str(e) or "cancelled by user" in str(e).lower()
            if stopped or _purge_on_cancel:
                removed = _purge_job_files()
                _download_state["error"] = "Stopped by user"
                _download_state["message"] = (
                    "Download stopped. Cleared from disk: "
                    + (", ".join(removed) if removed else "(nothing left to delete)")
                )
            else:
                _download_state["error"] = str(e)
                _download_state["message"] = (
                    "Interrupted or failed — partial .part files were kept. "
                    "Run the same download again to resume."
                )
            _download_state["active"] = False
            _download_state["done"] = True
        finally:
            try:
                _download_lock.release()
            except RuntimeError:
                pass

    try:
        threading.Thread(target=worker, daemon=True).start()
    except Exception:
        _download_lock.release()
        raise
    return {
        "ok": True,
        "message": "Download started (resumable on crash). Use Stop & clear to abort and delete files.",
        "file_count": len(files),
        "catalog_id": catalog_id,
    }


@app.post("/api/models/download")
def api_download(
    body: DownloadBody,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    ensure_layout()
    url = body.url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "URL must start with http:// or https://")
    if body.filename:
        try:
            filename = _safe_filename(body.filename)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    else:
        try:
            filename = _safe_filename(url.split("?", 1)[0].rstrip("/").split("/")[-1])
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    if not filename.lower().endswith(".gguf"):
        filename = filename + ".gguf"
    return _begin_download_job([(filename, url)])


@app.post("/api/models/download/catalog")
def api_download_catalog(
    body: CatalogDownloadBody,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    ensure_layout()
    cat = load_catalog(CATALOG_FILE)
    m = catalog_model(cat, body.id)
    if not m:
        raise HTTPException(404, f"Unknown catalog id: {body.id}")
    files = all_urls_for_model(m)
    if not files:
        raise HTTPException(
            400,
            "This catalog entry has no download URL yet (weights pending).",
        )
    if not body.include_mmproj:
        files = [(n, u) for n, u in files if "mmproj" not in n.lower()]
    return _begin_download_job(files, catalog_id=body.id)


@app.post("/api/models/download/cancel")
def api_download_cancel(
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    """Stop the active download and delete all files belonging to that job."""
    global _purge_on_cancel
    require_token(authorization, x_admin_token)
    _purge_on_cancel = True
    _cancel_event.set()
    # Best-effort immediate wipe; worker also purges after the file handle closes.
    removed = _purge_job_files()
    return {
        "ok": True,
        "message": (
            "Stop requested — clearing this download from disk"
            + (f" ({', '.join(removed)})" if removed else "")
            + "."
        ),
        "removed": removed,
    }


@app.get("/api/models/download/status")
def api_download_status(
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    st = dict(_download_state)
    # Refresh human fields
    st["bytes_human"] = format_mb(st.get("bytes") or 0)
    if st.get("total"):
        st["total_human"] = format_mb(st["total"])
    return st


@app.post("/api/models/select")
def api_select(
    body: SelectBody,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    ensure_layout()
    try:
        filename = _safe_filename(body.filename)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    path = MODELS_DIR / filename
    v = validate_gguf(path)
    if not v.ok:
        raise HTTPException(400, detail=f"Cannot select model: {v.reason}")
    write_env_value(ENV_FILE, "MODEL_PATH", f"/models/{filename}")
    return {"ok": True, "model_path": f"/models/{filename}", "warning": v.warning}


@app.post("/api/models/import")
def api_import_local(
    body: ImportBody,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    """Import a local host GGUF (any path) into models/ via hardlink or copy, then optionally select it."""
    require_token(authorization, x_admin_token)
    ensure_layout()
    try:
        result = import_local_model(
            body.path.strip().strip('"').strip("'"),
            MODELS_DIR,
            include_shards=body.include_shards,
            include_mmproj=body.include_mmproj,
        )
    except (ValueError, FileExistsError, OSError) as e:
        raise HTTPException(400, detail=str(e)) from e

    if body.select:
        primary = result["primary"]
        write_env_value(ENV_FILE, "MODEL_PATH", f"/models/{primary}")
        result["selected"] = True
        result["model_path"] = f"/models/{primary}"
        result["message"] = (
            result.get("message", "")
            + f" Selected {primary}. Click Start (auto-optimize) to serve it."
        )
    else:
        result["selected"] = False
    return result


@app.post("/api/models/scan-folder")
def api_scan_folder(
    body: ScanFolderBody,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    """List GGUFs in a host folder so the operator can Import one."""
    require_token(authorization, x_admin_token)
    try:
        rows = scan_folder_for_ggufs(body.folder.strip().strip('"').strip("'"))
    except ValueError as e:
        raise HTTPException(400, detail=str(e)) from e
    return {"folder": body.folder, "models": rows, "count": len(rows)}


@app.post("/api/server/start")
def api_start(
    body: ModeBody = ModeBody(),
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    ensure_layout()
    info = selected_model_info()
    if not info["valid"]:
        raise HTTPException(
            400,
            detail=(
                f"Refusing to start: selected model invalid — {info['reason']} "
                f"({info['host_path']}). Download/select a complete GGUF first."
            ),
        )
    mode = (body.mode or "").strip().lower() or None
    if mode and mode not in {"cuda", "cpu"}:
        raise HTTPException(400, "mode must be cuda or cpu")
    # Auto-optimize GPU layers (max VRAM use, CPU spill for the rest).
    return start_with_optimizer(mode)


@app.post("/api/server/stop")
def api_stop(
    body: ModeBody = ModeBody(),
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    mode = (body.mode or detect_mode()).lower()
    if mode not in {"cuda", "cpu"}:
        mode = detect_mode()
    # Stop both profiles to avoid leftover restarting containers
    messages = []
    for m in ("cuda", "cpu"):
        compose = compose_file_for(m)
        code, out, err = docker_compose(compose, "down", timeout=120)
        messages.append({"mode": m, "code": code, "out": (out or err)[-500:]})
    return {"ok": True, "results": messages}


@app.post("/api/server/restart")
def api_restart(
    body: ModeBody = ModeBody(),
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    api_stop(body, authorization, x_admin_token)
    return api_start(body, authorization, x_admin_token)


@app.get("/api/logs")
def api_logs(
    tail: int = 80,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    require_token(authorization, x_admin_token)
    tail = max(10, min(tail, 400))
    mode = detect_mode()
    name = container_name_for(mode)
    code, out, err = run_cmd(["docker", "logs", "--tail", str(tail), name], timeout=60)
    text = out or err
    if code != 0:
        # try the other container
        alt = container_name_for("cpu" if mode == "cuda" else "cuda")
        code2, out2, err2 = run_cmd(["docker", "logs", "--tail", str(tail), alt], timeout=60)
        text = out2 or err2 or text
        name = alt if code2 == 0 else name
    return {"container": name, "logs": text}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
def favicon() -> Response:
    # Avoid noisy 404s in browser / server logs
    return Response(status_code=204)


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def main() -> None:
    import uvicorn

    global ADMIN_TOKEN
    ensure_layout()
    ADMIN_TOKEN = get_or_create_token()
    host = os.environ.get("ADMIN_HOST", "0.0.0.0")
    port = int(os.environ.get("ADMIN_PORT", "8090"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
