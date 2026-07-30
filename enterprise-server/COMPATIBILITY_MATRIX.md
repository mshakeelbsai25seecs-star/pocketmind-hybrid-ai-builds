# PocketMind Hybrid AI Server Compatibility Matrix

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

PocketMind Hybrid AI does not require a specific server engine. It requires an OpenAI-compatible API contract:

```text
GET  /v1/models
POST /v1/chat/completions
```

If the server satisfies this contract, PocketMind Hybrid AI can use it through Organization Server Mode.

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

If the embeddings contract is not available, PocketMind Hybrid AI runs Knowledge Chat
embeddings locally with no loss of accuracy.

## PocketCode runtime modes

PocketCode can run with local or remote workspace hosts. Inference, workspace FS/tools,
provisioning, and UI are independent axes. Remote workspace tools are served by the
standalone **agent-host** (not the Full RAG gateway). See
[`agent-host/README.md`](agent-host/README.md) for bind/token/data env and smoke curls.

| Preset | Inference | Workspace tools | Provision | UI |
|---|---|---|---|---|
| **LocalClassic** | Local GGUF / desktop LLM | Local Tauri `cw_*` | none (open local folder) | Full desktop |
| **HybridBrain** | Org / online chat completions | Local Tauri `cw_*` | none | Full desktop |
| **RemoteAgentPreloaded** | Org / online (or local) | Remote agent-host HTTP | `preloaded` — bind existing server path | Full desktop thin over remote FS |
| **RemoteAgentSync** | Org / online (or local) | Remote agent-host HTTP | `client_sync` — upload zip/tar archive | Full desktop |
| **RemoteAgentGit** | Org / online (or local) | Remote agent-host HTTP | `git_clone` — server-side `git clone` | Full desktop |
| **ThinClient\*** | Org OpenAI-compatible API | Remote agent-host HTTP | preloaded / sync / git (profile-selected) | Thin / kiosk-style client |

### Ops steps (remote workspace)

1. Deploy `pocketcode-agent-host` with `AGENT_HOST_TOKEN`, `AGENT_HOST_BIND`, `AGENT_HOST_DATA`.
2. Provision workspaces via `/v1/workspaces/provision/{preloaded,sync,git}`.
3. Point the desktop runtime profile `remote.baseUrl` at the agent-host URL; reuse the Bearer token.
4. Keep Full RAG gateway (Knowledge Chat) on its own port/process — do not merge routes.
