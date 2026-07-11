# NexusAI Server Compatibility Matrix

| Server environment | Recommended profile | Notes |
|---|---|---|
| Ubuntu + 1 NVIDIA GPU | vLLM NVIDIA | Best general enterprise starting point |
| Ubuntu + multiple NVIDIA GPUs | vLLM multi-GPU | Best for large models and higher throughput |
| Ubuntu + CPU only | llama.cpp CPU or Ollama CPU | Works, but slower |
| Windows Server + NVIDIA GPU | WSL2 Ubuntu + vLLM or native Ollama | WSL2 path is usually cleaner for vLLM |
| Mac Studio / Mac mini | Ollama or llama.cpp Metal | Good for Apple Silicon unified memory deployments |
| Existing internal AI gateway | OpenAI-compatible endpoint | Best if company already has infra |
| No Docker allowed | Native vLLM/Ollama/llama.cpp | More manual; use IT approval |
| No GPU driver installed | CPU fallback only | Fix drivers before expecting speed |
| Multiple offices | VPN/internal DNS endpoint | Keep one stable endpoint URL |
| Public internet access required | HTTPS + authentication + firewall rules | Requires security review |

## Compatibility principle

NexusAI does not require a specific server engine. It requires an OpenAI-compatible API contract:

```text
GET  /v1/models
POST /v1/chat/completions
```

If the server satisfies this contract, NexusAI can use it through Organization Server Mode.

## Optional: Knowledge Chat embeddings contract

Knowledge Chat embeddings are local-first. To optionally offload them to the
organization server, the server must additionally expose:

```text
POST /v1/embeddings
```

served for both partition models (Nomic v1.5 for code, BGE-M3 for knowledge).
Because most engines (including llama.cpp) serve one model per process, the chat
model and each embedding model typically run as separate processes/ports. See
[`llama-cpp/docker-compose.embeddings.yml`](llama-cpp/docker-compose.embeddings.yml).

| Capability | Endpoint | Required? |
|---|---|---|
| Chat | `GET /v1/models`, `POST /v1/chat/completions` | Yes for Organization Server chat |
| Knowledge Chat embeddings (remote) | `POST /v1/embeddings` (Nomic + BGE-M3) | Optional; falls back to local |

If the embeddings contract is not available, NexusAI runs Knowledge Chat
embeddings locally with no loss of accuracy.
