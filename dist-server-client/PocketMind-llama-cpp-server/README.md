# llama.cpp Server Deployment Profile

OpenAI-compatible chat API for PocketMind Hybrid AI (`/v1/models`, `/v1/chat/completions`).

## Windows (recommended path)

See **[SETUP_WINDOWS.md](./SETUP_WINDOWS.md)** and **[START_HERE.txt](./START_HERE.txt)**.

**Double-click `START_ADMIN.cmd`** in this folder (do not run scripts from `C:\Windows\System32`).

```text
START_ADMIN.cmd   -> admin UI on http://127.0.0.1:8090
START_SERVER.cmd  -> start chat after a valid model is selected
PREFLIGHT.cmd     -> Docker / GPU / GGUF checks
SMOKE_TEST.cmd    -> curl.exe /v1/models
```

The `.cmd` launchers bypass PowerShell ExecutionPolicy and Mark-of-the-Web issues that block `.\start-admin.ps1` on many PCs.

Or without the UI (after a valid model is in `models\` and `.env`):

```powershell
cd C:\PocketMindServer\llama-cpp
powershell.exe -ExecutionPolicy Bypass -File .\start-server.ps1 -Mode cuda
powershell.exe -ExecutionPolicy Bypass -File .\scripts\smoke.ps1
```

**Important:** Always run from **this package directory**. Prefer the `.cmd` files over raw `docker compose` from a random folder.

In PowerShell use **`curl.exe`**, not `curl`.

## Linux / macOS shell

```bash
cd enterprise-server/llama-cpp
cp .env.example .env
mkdir -p models
# copy a complete model.gguf into ./models and set MODEL_PATH in .env
chmod +x start_llama_cpp.sh
./start_llama_cpp.sh cuda   # or: cpu
```

`start_llama_cpp.sh` now **refuses to start** if the GGUF is missing, tiny, or not a GGUF file.

## PocketMind Hybrid AI URL

```text
http://SERVER_IP:8000/v1
```

Admin UI (optional, host Python app):

```text
http://SERVER_IP:8090/
```

## Compose behavior

- Restart policy: `on-failure:3` (avoids endless silent restart loops on a bad model)
- Healthcheck: TCP probe on port 8000 after start period
- Always validate the model with `preflight.ps1` or the admin UI before start

## Knowledge Chat embeddings (optional)

PocketMind Hybrid AI can offload Knowledge Chat dense embeddings to this server. Because
`llama-server` serves a single model per process, embeddings run as **separate
services** from chat — one per partition (code uses Nomic v1.5, knowledge uses
BGE-M3). Local embeddings remain the default and the automatic fallback, so
retrieval never degrades if the server is unreachable.

### Start embedding services

```bash
cd enterprise-server/llama-cpp
cp .env.example .env
mkdir -p models
# copy nomic-embed-text-v1.5.Q4_K_M.gguf and bge-m3-Q4_K_M.gguf into ./models

# GPU (NVIDIA):
docker compose -f docker-compose.embeddings.yml up -d

# CPU only:
docker compose -f docker-compose.embeddings.cpu.yml up -d
```

This exposes:

```text
http://SERVER_IP:8001/v1/embeddings   # code partition  (Nomic)
http://SERVER_IP:8002/v1/embeddings   # knowledge partition (BGE-M3)
```

### Configure clients

In PocketMind Hybrid AI open **Organization Server** and:

1. Enable "Use organization server for Knowledge Chat embeddings".
2. Enter the served model ids (for example `nomic-embed-text-v1.5` and `bge-m3`).
3. Set the embeddings base URL if the embed services are on a different
   host/port than chat (for example `http://SERVER_IP:8001/v1` for code). If a
   single reverse proxy fronts both models on one base URL, leave it blank to
   reuse the chat URL.
4. Click **Test connection** — the probe calls `/v1/embeddings` for each model.

If you front both ports behind one base URL, use a reverse proxy that routes by
the `model` field in the request body (see `enterprise-server/nginx`).
