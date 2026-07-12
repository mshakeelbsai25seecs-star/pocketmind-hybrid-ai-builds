# NexusAI Full Server RAG (pilot)

Private GPU/CPU stack that runs embeddings, reranking, LLM, and a Knowledge Chat
gateway. Desktop clients send **prompts + Bearer token only** — indexing and
retrieval stay on the server.

## Ports

| Service | Port | Role |
|---------|------|------|
| llm | 8000 | Chat completions (GGUF via llama.cpp) |
| embed-code | 8001 | Code partition embeddings (Qwen3-Embedding) |
| embed-knowledge | 8002 | Knowledge partition embeddings (bge-m3) |
| rerank | 8003 | Qwen3-Reranker (`/v1/rerank`) |
| gateway | 8080 | Auth + Knowledge Chat + admin index |

## Locked admin workflow

1. Copy document folders to `/opt/nexusai/data/collections/<name>/` on the server.
2. Index with `./scripts/index_collection.sh <name>`.
3. Give employees the gateway URL (`http://<server>:8080/v1`) and Bearer token.

## One-shot setup (Linux NVIDIA)

```bash
cd enterprise-server/full-rag
cp .env.example .env
# optional: edit model URLs / paths in .env
chmod +x scripts/*.sh
./scripts/setup.sh
```

`setup.sh` will:

- Check Docker / Compose
- Create `/opt/nexusai/models` and `/opt/nexusai/data` (or paths from `.env`)
- Download GGUFs via `download_models.sh` (HF URLs configurable in `.env`)
- Generate `NEXUSAI_SERVER_TOKEN` if missing
- `docker compose up -d --build`
- Wait for gateway `/health`
- Optionally seed `collections/qa-corpus` from repo `test-fixtures/kc-qa-corpus`
- Print gateway URL + token

### CPU fallback

```bash
./scripts/setup.sh --cpu
# or:
docker compose -f docker-compose.yml -f docker-compose.cpu.yml up -d --build
```

## Index a collection

```bash
# After copying files into /opt/nexusai/data/collections/qa-corpus
./scripts/index_collection.sh qa-corpus

# Force rebuild
./scripts/index_collection.sh qa-corpus --rebuild
```

Docker exec alternative:

```bash
docker exec -it nexusai-rag-gateway sh
curl -X POST http://127.0.0.1:8080/v1/admin/index \
  -H "Authorization: Bearer $NEXUSAI_SERVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"qa-corpus","rebuild":false}'
```

## Seed QA corpus

`setup.sh` copies `test-fixtures/kc-qa-corpus` → `/opt/nexusai/data/collections/qa-corpus`
when the fixture exists next to this package in a full repo checkout.

Manual:

```bash
mkdir -p /opt/nexusai/data/collections/qa-corpus
cp -a ../../test-fixtures/kc-qa-corpus/. /opt/nexusai/data/collections/qa-corpus/
./scripts/index_collection.sh qa-corpus
```

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

Local Knowledge Chat mode is unchanged when Server RAG is off.

## Optional nginx

Copy `nginx/nexus-rag.conf` into your nginx `conf.d` and point TLS at the gateway.

## Host binary (without Docker gateway image)

```bash
cd src-tauri
cargo build --release --bin nexus-rag-gateway
export NEXUS_DATA_ROOT=/opt/nexusai/data
export NEXUSAI_SERVER_TOKEN=...
export LLM_BASE_URL=http://127.0.0.1:8000/v1
export EMBED_CODE_URL=http://127.0.0.1:8001/v1
export EMBED_KNOWLEDGE_URL=http://127.0.0.1:8002/v1
export NEXUS_RERANK_URL=http://127.0.0.1:8003
export BIND=0.0.0.0:8080
./target/release/nexus-rag-gateway
```

## Volumes

- `${NEXUS_MODELS_HOST}` → `/models` (GGUFs)
- `${NEXUS_DATA_HOST}` → `/opt/nexusai/data` (collections + gateway SQLite)
