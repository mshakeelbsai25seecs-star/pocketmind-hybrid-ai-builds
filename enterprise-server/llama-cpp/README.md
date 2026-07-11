# llama.cpp Server Deployment Profile

Use this for GGUF models, simple private deployments, and CPU fallback servers.

## Start CPU mode

```bash
cd enterprise-server/llama-cpp
cp .env.example .env
mkdir -p models
# copy model.gguf into ./models
chmod +x start_llama_cpp.sh
./start_llama_cpp.sh cpu
```

## Start CUDA mode

```bash
./start_llama_cpp.sh cuda
```

## NexusAI URL

```text
http://SERVER_IP:8000/v1
```

## Knowledge Chat embeddings (optional)

NexusAI can offload Knowledge Chat dense embeddings to this server. Because
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

In NexusAI open **Organization Server** and:

1. Enable "Use organization server for Knowledge Chat embeddings".
2. Enter the served model ids (for example `nomic-embed-text-v1.5` and `bge-m3`).
3. Set the embeddings base URL if the embed services are on a different
   host/port than chat (for example `http://SERVER_IP:8001/v1` for code). If a
   single reverse proxy fronts both models on one base URL, leave it blank to
   reuse the chat URL.
4. Click **Test connection** — the probe calls `/v1/embeddings` for each model.

If you front both ports behind one base URL, use a reverse proxy that routes by
the `model` field in the request body (see `enterprise-server/nginx`).
