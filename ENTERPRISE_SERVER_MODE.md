# PocketMind Hybrid AI Enterprise Server Mode

PocketMind Hybrid AI Enterprise Server Mode lets Windows, macOS, and Android clients connect to a company-owned private AI server instead of forcing every employee laptop to run the model locally.

## Production concept

```text
Employees use the normal PocketMind Hybrid AI app.
The company server runs the selected AI model.
PocketMind Hybrid AI connects to an OpenAI-compatible endpoint such as http://10.0.0.20:8000/v1.
The server can grow from one GPU to multiple GPUs without changing the client app.
Data can remain inside the company LAN or VPN.
```

## Universal compatibility strategy

PocketMind Hybrid AI does not depend on one specific server engine. It depends on a stable API contract:

```text
GET  /v1/models
POST /v1/chat/completions
```

This lets PocketMind Hybrid AI work with:

- vLLM for high-throughput NVIDIA and multi-GPU servers.
- Ollama for simple pilots and medium models.
- llama.cpp server for GGUF-based private deployments.
- Hugging Face Text Generation Inference where suitable.
- Existing internal OpenAI-compatible company gateways.

### Optional: Knowledge Chat embeddings

Knowledge Chat embeddings run locally by default. To offload them to the
organization server as well, the server must additionally expose:

```text
POST /v1/embeddings
```

served for both partition models (Nomic v1.5 for code, BGE-M3 for knowledge).
Enable this from **Organization Server** settings. If the endpoint is missing or
unreachable, PocketMind Hybrid AI automatically falls back to local embeddings with no loss
of accuracy. See [`enterprise-server/llama-cpp/docker-compose.embeddings.yml`](enterprise-server/llama-cpp/docker-compose.embeddings.yml)
for a ready-to-run two-model embedding deployment.

## Deployment kit

The `enterprise-server` folder contains multiple deployment profiles:

```text
enterprise-server/vllm       -> recommended enterprise NVIDIA/multi-GPU path
enterprise-server/ollama     -> simple pilot path
enterprise-server/llama-cpp  -> GGUF/CPU/CUDA fallback path
enterprise-server/tgi        -> Hugging Face TGI path
enterprise-server/nginx      -> internal reverse proxy starter
enterprise-server/scripts    -> hardware and deployment checks
```

Start with:

```text
enterprise-server/README_START_HERE.md
enterprise-server/DEPLOYMENT_DECISION_TREE.md
enterprise-server/SECURITY_CHECKLIST.md
```

## Client setup

Inside PocketMind Hybrid AI:

1. Open **Organization Server**.
2. Enter the internal server URL, for example `http://192.168.1.50:8000/v1`.
3. Enter the company access token if required.
4. Click **Test connection**.
5. Click **Load models**.
6. Choose a model and click **Use in Chat**.

PocketMind Hybrid AI will create a new server chat and stream responses from the company server.

## Scaling design

The PocketMind Hybrid AI client does not need to know whether the server has one GPU, four GPUs, or a larger cluster. The server engine handles tensor parallelism, pipeline parallelism, batching, and model placement. PocketMind Hybrid AI only talks to one stable OpenAI-compatible endpoint.

This makes the system scalable:

- Start with one GPU workstation.
- Upgrade to multiple GPUs.
- Put the server behind an internal reverse proxy.
- Keep the same URL for all employees.
- Upgrade models without changing the client app.

## Honest limitation

No package can run on every server with no exceptions. Drivers, GPUs, Docker permissions, firewalls, model sizes, and company security policies differ. PocketMind Hybrid AI handles this professionally by supporting multiple deployment profiles and by requiring one standard OpenAI-compatible endpoint.
