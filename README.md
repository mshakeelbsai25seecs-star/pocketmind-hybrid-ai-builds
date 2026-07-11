# NexusAI

Offline-first desktop AI workspace built with **Tauri 1**, **Rust**, and **React**. Local GGUF chat, folder-grounded Knowledge Chat (RAG), runtime management, and optional enterprise OpenAI-compatible server mode.

```bash
git clone https://github.com/noumanshakeel555-lang/nexus-ai-deep-fixed.git
cd nexus-ai-deep-fixed
```

> Private repository — clone with credentials you already have access to.

## Features

- **Local chat** — run GGUF models via bundled llama.cpp (`cpu` / `cuda` / `vulkan` on Windows; Metal on macOS)
- **Knowledge Chat** — select a folder, index it locally, ask questions grounded only in retrieved snippets
- **Accuracy-first RAG** — hybrid FTS + dense retrieval, confidence gating, extractive answers preferred over LLM paraphrase when evidence is strong
- **Pipeline diagnostics** — per-stage I/O traces with culprit attribution when retrieval fails or degrades
- **Partitioned embeddings** — Qwen3-Embedding-8B for code; BGE-M3 for docs; Qwen3-Reranker GGUF as the primary reranker (ONNX/phrase fallbacks if the GGUF is missing)
- **Deployment settings** — data root, models dir, GPU layers, context size (Settings → Deployment)
- **Enterprise server mode** — connect clients to a company OpenAI-compatible endpoint (see `ENTERPRISE_SERVER_MODE.md`)
- **SOC / Fortinet Copilot** — separate module from Knowledge Chat (see product docs under `distribution/` and `FORTINET_SOC_DEMO_GUIDE.md`)

## Knowledge Chat (RAG)

Knowledge Chat indexes a local folder and answers from that index only.

| Role | Model (typical GGUF) |
|------|----------------------|
| Chat LLM | Phi-3 (e.g. Phi-3 Mini Instruct) |
| Code embeddings | Qwen3-Embedding-8B |
| Doc embeddings | BGE-M3 |
| Primary rerank | Qwen3-Reranker GGUF (llama.cpp RANK); ONNX / phrase are fallbacks |

Expected Windows drop paths (under the data root):

```text
D:\NexusAI\models\embeddings\Qwen3-Embedding-8B-Q4_K_M.gguf
D:\NexusAI\models\embeddings\bge-m3-Q4_K_M.gguf
D:\NexusAI\models\rerankers\Qwen3-Reranker-4B-Q4_K_M.gguf
```

Download pages are linked in-app / in `src/knowledgeChat/retrievalConfig.ts`. Deeper module docs: [`KNOWLEDGE_CHAT.md`](./KNOWLEDGE_CHAT.md).

## Requirements

| Tool | Notes |
|------|--------|
| **Node.js** | 18+ recommended (Vite 5 / React 18) |
| **Rust** | 1.70+ (`src-tauri/Cargo.toml`) |
| **Tauri CLI** | via `npm` (`@tauri-apps/cli`) |
| **llama.cpp** | Place `llama-server` under `bin/llama.cpp/` (see Runtime layout below) |
| **Disk** | Prefer a large drive for models and indexes (Windows default `D:\NexusAI`) |

Platform toolchains: [Tauri 1 prerequisites](https://v1.tauri.app/v1/guides/getting-started/prerequisites/) (MSVC on Windows, Xcode CLT on macOS, etc.).

## Setup

```bash
npm install
```

Ensure llama.cpp runtimes exist (not committed; `bin/` is gitignored):

**Windows**

```text
bin/llama.cpp/cpu/llama-server.exe
bin/llama.cpp/cuda/llama-server.exe      # optional NVIDIA
bin/llama.cpp/vulkan/llama-server.exe   # optional Vulkan
```

**macOS** — see [`MAC_BUILD_GUIDE.md`](./MAC_BUILD_GUIDE.md) for `macos-arm64-metal` / `macos-x64-*` layouts.

Then start the desktop app:

```bash
# Full Tauri + Vite (preferred for UI + Rust)
npm run tauri:dev:low-mem

# Or standard Tauri dev
npm run tauri -- dev

# Frontend only (no Rust backend)
npm run dev
```

`tauri:dev:low-mem` sets `CARGO_BUILD_JOBS=1`, points cargo target/cache at a large drive when possible, and sets `NEXUS_DATA_ROOT=D:\NexusAI` (Windows PowerShell script: `scripts/tauri-dev-low-mem.ps1`).

### Release build

```bash
npm run tauri -- build
# Windows staging helper:
npm run dist:stage:windows
```

## Configuration and data paths

### Data root

Resolved in this order:

1. `NEXUS_DATA_ROOT` environment variable  
2. Platform default:
   - **Windows:** `D:\NexusAI`
   - **macOS:** `~/Library/Application Support/NexusAI` (or `/Library/Application Support/NexusAI` when `NEXUS_DEPLOY_MODE=server`)
   - **Linux:** `/var/lib/nexusai`

Under the data root you typically get:

| Path | Purpose |
|------|---------|
| `models/` | Chat, embedding, and reranker GGUFs |
| `app-data/` | SQLite app DB |
| `knowledge-chat/` | KC indexes / HNSW |
| `company-data/` | SOC company data root |
| `exports/` | Export output |
| `cache/` | Process caches / temp (`NEXUS_TMP`) |
| `qa-corpus/` | Auto-copied QA fixture (dev / demo) |

Paths are also editable in **Settings → Deployment**.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `NEXUS_DATA_ROOT` | Override data root |
| `NEXUS_MODELS_DIR` | Override models directory |
| `NEXUS_EMBEDDING_MODEL` | Default embedding GGUF path |
| `NEXUS_SOC_DATA_ROOT` | SOC / company-data root |
| `NEXUS_EXPORT_DIR` | Export directory |
| `NEXUS_CONTEXT_SIZE` | Chat context size |
| `NEXUS_MAX_TOKENS` | Max generation tokens |
| `NEXUS_GPU_LAYERS` | GPU offload layers (`-1` = auto) |
| `NEXUS_DEPLOY_MODE` | `server` raises default context/batch (and macOS server data path) |
| `NEXUS_ALLOWED_PATHS` | Extra allowed path roots (`;` or `:` separated) |
| `NEXUS_LLAMA_SERVER` / `LLAMA_SERVER_PATH` | Explicit llama-server binary |
| `NEXUS_KC_MAX_EMBED_SESSIONS` | Cap concurrent KC embed sessions (low-memory) |
| `NEXUS_QA_CORPUS_SOURCE` | Override QA corpus fixture source |
| `NEXUS_QA_SKIP_DENSE` | Skip dense indexing for QA corpus when set |

Do not commit API keys or `.env` files (`.env` is gitignored). Online provider keys are entered in the Models UI and stored locally.

## Development commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite frontend only |
| `npm run build` | Typecheck + production frontend build |
| `npm run preview` | Preview Vite production build |
| `npm run tauri` | Tauri CLI passthrough |
| `npm run tauri:dev:low-mem` | Low-memory Tauri dev (Windows PowerShell) |
| `npm run dist:stage:windows` | Stage Windows desktop release payload |

Rust crate: `src-tauri/` (`cargo check` / `cargo test` from that directory).

## Project structure

```text
├── src/                    # React + TypeScript UI
│   ├── components/         # Chat, Settings, Runtime, SOC, Knowledge Chat UI
│   └── knowledgeChat/      # KC client: API, prompts, answer pipeline, traces
├── src-tauri/              # Rust / Tauri backend (single crate, not a Cargo workspace)
│   └── src/
│       ├── knowledge_chat/ # Folder RAG: scan, index, search, rerank, diagnose
│       ├── llm/            # Local llama.cpp + remote OpenAI-compatible clients
│       ├── deployment.rs   # Data roots, env overrides, path policy
│       └── ...
├── scripts/                # Dev helpers (e.g. tauri-dev-low-mem.ps1)
├── distribution/           # Packaged desktop/server docs and staging
├── enterprise-server/      # Server deployment profiles (vLLM, Ollama, …)
├── test-fixtures/          # QA corpus and eval fixtures
├── KNOWLEDGE_CHAT.md       # Knowledge Chat deep dive
└── ENTERPRISE_SERVER_MODE.md
```

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| App starts but chat fails | **Runtime → Scan runtime**; confirm `bin/llama.cpp/.../llama-server` exists |
| Out of memory while compiling | Use `npm run tauri:dev:low-mem`; set `CARGO_TARGET_DIR` on a large drive |
| Embeddings / semantic search off | Place embedding GGUFs under `{data_root}/models/embeddings/` or Browse in Deployment / Collection settings |
| Rerank skipped / weak | Add primary Qwen3-Reranker GGUF under `models/rerankers/`; check pipeline diagnostics (`llama_rank` stage). ONNX/phrase run only if Qwen RANK did not apply |
| Weak or empty KC answers | Rebuild the collection index; open pipeline diagnostics for the failing stage |
| GPU not used | Install matching CUDA/Vulkan (or Metal) runtime folder + drivers; GPU layers `-1` enables auto fallback |

More release and platform notes: [`README_RELEASE.txt`](./README_RELEASE.txt), [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md), [`MAC_BUILD_GUIDE.md`](./MAC_BUILD_GUIDE.md).

## License / status

Private project (`"private": true` in `package.json`). Version `0.1.0`. Contact the repository owner for access and contribution guidelines.
