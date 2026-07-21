# PocketMind Hybrid AI Full Server RAG (pilot)

Private GPU/CPU stack that runs embeddings, reranking, LLM, and a Knowledge Chat
gateway. Desktop clients send **prompts + Bearer token only** — indexing and
retrieval stay on the server.

## Supported / unsupported

| Environment | Status |
|---|---|
| Linux x86_64 + Docker Compose v2 + NVIDIA (Container Toolkit working) | Supported (`gpu` / `gpu-small`) |
| Linux x86_64 + Docker, no GPU or toolkit broken | Supported (`cpu` auto-fallback) |
| Windows Server via **WSL2 Ubuntu + Docker** | Supported — see [docs/WSL2_WINDOWS_SERVER.md](docs/WSL2_WINDOWS_SERVER.md) |
| ARM / Apple Silicon / macOS Metal | Not supported for this package |
| Native Windows Docker Desktop (no WSL Linux engine) | Not supported |
| Air-gapped (no registry / Hugging Face) | Not supported in this pass — use online install |

Paths `/opt/nexusai/{models,data}` are for **this Docker stack**. They are not the desktop data dirs (`/var/lib/pocketmind` or `C:\ProgramData\PocketMind`).

## Ports

| Service | Port | Role |
|---------|------|------|
| llm | 8000 | Chat completions (GGUF via llama.cpp) |
| embed-code | 8001 | Code partition embeddings (Qwen3-Embedding) |
| embed-knowledge | 8002 | Knowledge partition embeddings (bge-m3) |
| rerank | 8003 | Qwen3-Reranker (`/v1/rerank`) |
| gateway | 8080 | Auth + Knowledge Chat + admin index |

## One-shot install (recommended)

```bash
cd enterprise-server/full-rag   # or the full-rag folder from the server zip
cp .env.example .env            # optional: edit paths / URLs
chmod +x scripts/*.sh
./scripts/install.sh
./scripts/smoke_test.sh
```

`install.sh` will:

1. Run preflight (arch, Docker, ports, disk/RAM, Hugging Face / registry)
2. Select profile: `gpu`, `gpu-small` (unknown or &lt;20 GiB VRAM), or `cpu` (writes `NEXUS_DEPLOY_PROFILE` in `.env`)
3. Probe real Docker GPU access (not just `nvidia-smi`)
4. Create data dirs — defaults `/opt/nexusai/{models,data}`, auto-fallback to `~/nexusai/...` if not writable
5. Download GGUFs (retries; GGUF magic + size checks; skips existing good files)
6. `docker compose up -d --build` with the right overlays (base is CPU-safe; GPU devices only in `docker-compose.gpu.yml`)
7. Healthgate all services (LLM, embeds, rerank, gateway)
8. Print gateway URL + Bearer token

### Useful flags

```bash
./scripts/install.sh --cpu              # force CPU overlay
./scripts/install.sh --gpu              # require working NVIDIA-in-Docker
./scripts/install.sh --skip-models      # GGUFs already on disk
./scripts/install.sh --no-seed          # skip optional qa-corpus copy
./scripts/install.sh --allow-busy-ports # do not fail if ports look busy
```

`scripts/setup.sh` still works; it delegates to `install.sh`.

## Locked admin workflow

1. Copy document folders to `/opt/nexusai/data/collections/<name>/` on the server.
2. Index with `./scripts/index_collection.sh <name>`.
3. Give employees the gateway URL (`http://<server>:8080/v1`) and Bearer token.

## Index a collection

```bash
./scripts/index_collection.sh qa-corpus
./scripts/index_collection.sh my-docs --rebuild
```

## Seed QA corpus

`install.sh` copies `test-fixtures/kc-qa-corpus` → `/opt/nexusai/data/collections/qa-corpus`
when the fixture exists in a full repo checkout.

## Gateway API

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/health` | no | Liveness |
| GET | `/v1/models` | Bearer | Proxies LLM `/v1/models` |
| GET | `/v1/knowledge/collections` | Bearer | List indexed collections |
| POST | `/v1/knowledge/chat` | Bearer | `{ collection_id\|name, message }` → `{ answer, sources, collection_id }` |
| POST | `/v1/admin/index` | Bearer | `{ name, rebuild? }` indexes `/opt/nexusai/data/collections/<name>` |

## Desktop thin client

1. Org Server → set URL to `http://<server>:8080/v1`, paste Bearer token, Save.
2. Enable **Server RAG (Knowledge Chat on org gateway)**.
3. Open Knowledge Chat — collections load from the gateway; chat skips local embed/search.

## Optional nginx

Copy `nginx/nexus-rag.conf` into your nginx `conf.d` and point TLS at the gateway.

## Volumes

- `${NEXUS_MODELS_HOST}` → `/models` (GGUFs)
- `${NEXUS_DATA_HOST}` → `/opt/nexusai/data` (collections + gateway SQLite)

## Validate before a customer deploy

On a GPU Linux box and once with `--cpu`:

```bash
./scripts/install.sh
./scripts/smoke_test.sh
```
