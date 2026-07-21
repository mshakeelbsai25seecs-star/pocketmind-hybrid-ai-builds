# PocketMind Hybrid AI (macOS)

Offline-first desktop AI workspace for **Apple Silicon and Intel Macs**.

Built with **Tauri 1**, **Rust**, and **React**. Run local GGUF chat, index any folder for grounded Knowledge Chat (RAG), manage llama.cpp runtimes automatically, and optionally connect to an enterprise OpenAI-compatible server.

```bash
git clone https://github.com/noumanshakeel555-lang/nexus-ai-mac.git
cd nexus-ai-mac
```

> Private repository — clone with a GitHub account that has access.

---

## Why this Mac build exists

PocketMind Hybrid AI must work on **every Mac architecture**:

| Mac family | CPU arch | Runtime folders used |
|------------|----------|----------------------|
| Apple Silicon (M1/M2/M3/M4…) | `arm64` | `macos-arm64-metal`, `macos-arm64-cpu` |
| Intel Mac | `x86_64` | `macos-x64-metal`, `macos-x64-cpu` |

The app **detects the host architecture at runtime** and only launches the matching native `llama-server`. It will not try to run an Intel binary on Apple Silicon or the reverse.

GPU acceleration is advertised only when a real backend library is present (for Metal: `libggml-metal*`). A folder named `metal` without those libraries is treated as CPU-only so the UI cannot claim GPU support that does not exist.

---

## Features

- **Local chat** — GGUF models via bundled llama.cpp (Metal when available, CPU fallback always)
- **Knowledge Chat** — select a folder, index locally, ask questions grounded only in retrieved sources
- **Accuracy-first RAG** — hybrid FTS + dense retrieval, confidence gating, extractive / structured answers when evidence is strong
- **File-purpose answers** — questions like “what does `overviewEvents.ts` do?” get structured Purpose / Key symbols / How it works answers
- **Pipeline diagnostics** — per-stage traces when retrieval or generation degrades
- **Partitioned embeddings** — code vs docs embedding models; Qwen3-Reranker GGUF primary (ONNX/phrase fallbacks)
- **Universal Runtime Manager** — scans native runtimes, GPU libraries, VRAM/RAM, and suggests CPU Safe / Automatic Optimizer
- **Deployment settings** — data root, models dir, GPU layers, context size
- **Enterprise server mode** — optional company OpenAI-compatible endpoint (see `ENTERPRISE_SERVER_MODE.md`)

---

## How it works (architecture)

```text
┌─────────────────────────────────────────────────────────────┐
│  React UI (Vite)                                            │
│  Chat · Knowledge Chat · Runtime · Models · Settings        │
└──────────────────────────┬──────────────────────────────────┘
                           │ Tauri IPC commands
┌──────────────────────────▼──────────────────────────────────┐
│  Rust backend (src-tauri)                                   │
│  · llm/local.rs          — chat via llama-server            │
│  · llm/runtime_discovery — native arch + Metal/CPU select   │
│  · knowledge_chat/       — index, search, rerank, answer    │
│  · hardware.rs           — RAM / GPU / VRAM probes          │
│  · deployment.rs         — data roots & path policy         │
└──────────────────────────┬──────────────────────────────────┘
                           │ spawns / HTTP
┌──────────────────────────▼──────────────────────────────────┐
│  llama-server (bin/llama.cpp/macos-<arch>-metal|cpu)        │
│  Chat GGUF · Embedding GGUF · optional Rerank GGUF          │
└─────────────────────────────────────────────────────────────┘
```

**Answer pipeline (Knowledge Chat)**

1. Query intent (file purpose, symbol explain, imports, env var, …)
2. Hybrid retrieval (lexical FTS + dense vectors when embeddings exist)
3. Rerank (Qwen RANK GGUF → dense-pair → ONNX/phrase fallbacks)
4. Structured / extractive answer when deterministic evidence is enough
5. Otherwise grounded LLM synthesis from attached source files only
6. Empty / ungrounded model output falls back to structured or evidence answers

**Data on disk** (default macOS):

```text
~/Library/Application Support/PocketMind/
  models/           # chat, embeddings, rerankers (.gguf)
  app-data/         # SQLite
  knowledge-chat/   # indexes / vectors
  company-data/     # SOC / company roots
  exports/
  cache/
```

Override with `NEXUS_DATA_ROOT`.

---

## Requirements

| Tool | Notes |
|------|--------|
| **macOS** | 12+ recommended; Apple Silicon or Intel |
| **Node.js** | 18+ (Vite 5 / React 18) |
| **Rust** | 1.70+ (`rustup` recommended) |
| **Xcode Command Line Tools** | `xcode-select --install` |
| **cmake / git / curl / python3** | for runtime setup / optional Metal rebuild |
| **Disk** | models are large (hundreds of MB to multi‑GB each) |

Tauri prerequisites: [Tauri 1 getting started](https://v1.tauri.app/v1/guides/getting-started/prerequisites/).

---

## Quick start (new Mac user)

### 1. Clone and install

```bash
git clone https://github.com/noumanshakeel555-lang/nexus-ai-mac.git
cd nexus-ai-mac
npm install
```

### 2. Install universal llama.cpp runtimes (required)

`bin/` is gitignored (binaries are large). Install **both** Apple Silicon and Intel folders so the same checkout works on any Mac:

```bash
npm run setup:macos-runtimes
# or: ./scripts/setup_macos_runtimes.sh
```

This downloads the latest official llama.cpp macOS arm64 + x64 releases and places:

```text
bin/llama.cpp/macos-arm64-metal/llama-server
bin/llama.cpp/macos-arm64-cpu/llama-server
bin/llama.cpp/macos-x64-metal/llama-server
bin/llama.cpp/macos-x64-cpu/llama-server
```

Verify:

```bash
npm run verify:macos-runtimes
```

### 3. Intel Mac GPU (optional but recommended)

Official Intel (`macos-x64`) archives are often **CPU-only**. If you have a discrete Metal GPU (for example AMD Radeon Pro) and want GPU offload:

```bash
npm run build:macos-x64-metal
# or: ./scripts/build_macos_x64_metal_runtime.sh
```

Re-run verify afterward — `macos-x64-metal` should report `libggml-metal` present.  
`setup:macos-runtimes` **preserves** an existing Metal build when the official tarball has no Metal libs.

Apple Silicon Metal is usually included in the official arm64 archive — no extra build step.

### 4. Start the app

```bash
npm run tauri:dev:macos
```

Alternatives:

```bash
npm run tauri:dev          # standard Tauri + Vite
npm run tauri -- dev       # same via CLI
npm run dev                # frontend only (no Rust / no local models)
```

### 5. First-run in the UI

1. **Runtime → Scan runtime** — confirm native runtime found; use **Automatic Optimizer** or **CPU Safe**
2. **Models** — import/scan a chat GGUF (start small if RAM is tight, e.g. Phi‑3 Mini)
3. Place embedding models (optional for dense search):

```text
~/Library/Application Support/PocketMind/models/embeddings/bge-m3-Q4_K_M.gguf
~/Library/Application Support/PocketMind/models/embeddings/Qwen3-Embedding-8B-Q4_K_M.gguf   # real GGUF, not an HTML page
~/Library/Application Support/PocketMind/models/rerankers/Qwen3-Reranker-4B-Q4_K_M.gguf
```

Download via Hugging Face **Files → resolve/main/…gguf** links (not the repo homepage HTML).

4. **Knowledge Chat** — create a collection, index a folder, ask grounded questions

---

## Development commands

| Command | Description |
|---------|-------------|
| `npm install` | Install JS dependencies |
| `npm run setup:macos-runtimes` | Download/install arm64 + x64 llama.cpp |
| `npm run verify:macos-runtimes` | Check arch, `--help`, Metal libs |
| `npm run build:macos-x64-metal` | Build real Metal runtime (Intel Mac GPU) |
| `npm run tauri:dev:macos` | Recommended macOS Tauri dev launcher |
| `npm run tauri:dev` | `tauri dev` |
| `npm run build` | Typecheck + Vite production frontend |
| `npm run build:macos-release` | Check runtimes + build `.app` / `.dmg` |
| `cd src-tauri && cargo check` | Compile Rust backend |
| `cd src-tauri && cargo test` | Rust unit tests |

### Release / universal `.app`

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:macos-release
```

Outputs under `src-tauri/target/release/bundle/`. For distribution outside your machine, plan Apple code signing and notarization (see `MAC_BUILD_GUIDE.md`).

Ensure the packaged app still includes (or ships beside) all four `bin/llama.cpp/macos-*` folders.

---

## Runtime detection rules (no more fake GPU)

| Check | Behavior |
|-------|----------|
| Host arch | Only `macos-arm64-*` on Apple Silicon; only `macos-x64-*` on Intel |
| Metal folder | Must contain `libggml-metal*`; otherwise forced CPU |
| Auto plan | GPU layers recommended only when a real GPU backend library exists |
| VRAM | Apple Silicon ≈ unified memory; Intel discrete/iGPU uses reported VRAM (not “16 GB RAM = VRAM”) |
| Fallback | Full Metal offload → fewer layers → CPU |

In **Runtime → Scan runtime** you should see honest statuses:

- **GPU acceleration: Backend ready** only if Metal/CUDA/Vulkan libs exist  
- **CPU fallback** when they do not  
- Warnings if a `metal` folder is CPU-only

---

## Knowledge Chat models

| Role | Typical GGUF |
|------|----------------|
| Chat LLM | Phi‑3 Mini / Llama 3 8B (size vs RAM tradeoff) |
| Code embeddings | Qwen3-Embedding‑8B (must be a real GGUF with magic `GGUF`) |
| Doc embeddings | BGE‑M3 |
| Primary rerank | Qwen3-Reranker GGUF (llama.cpp `--reranking`) |

GGUF files are validated by magic header + minimum size so Hugging Face HTML error pages saved as `.gguf` are rejected with a clear message.

Deeper module docs: [`KNOWLEDGE_CHAT.md`](./KNOWLEDGE_CHAT.md).

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `NEXUS_DATA_ROOT` | Override data root (default macOS: `~/Library/Application Support/PocketMind`) |
| `NEXUS_MODELS_DIR` | Override models directory |
| `NEXUS_EMBEDDING_MODEL` | Default embedding GGUF path |
| `NEXUS_CONTEXT_SIZE` | Chat context size |
| `NEXUS_MAX_TOKENS` | Max generation tokens |
| `NEXUS_GPU_LAYERS` | GPU offload (`-1` = auto, `0` = CPU) |
| `NEXUS_LLAMA_SERVER` / `LLAMA_SERVER_PATH` | Force a specific llama-server binary |
| `NEXUS_KC_MAX_EMBED_SESSIONS` | Cap concurrent embedding servers (low RAM) |
| `NEXUS_DEPLOY_MODE` | `server` raises defaults / server data path |

Do not commit API keys or `.env` files.

---

## Project structure

```text
├── src/                      # React + TypeScript UI
│   ├── components/           # Chat, Runtime, Models, Knowledge Chat, Settings
│   └── knowledgeChat/        # Client answer pipeline, prompts, traces
├── src-tauri/                # Rust / Tauri backend
│   └── src/
│       ├── knowledge_chat/   # Scan, index, search, rerank, structured answers
│       ├── llm/              # llama.cpp + remote clients + runtime discovery
│       ├── hardware.rs       # System / GPU probes
│       └── deployment.rs     # Paths and policy
├── scripts/
│   ├── setup_macos_runtimes.sh / verify_macos_runtimes.sh / tauri-dev-macos.sh
│   ├── install_llama_cpp_runtimes.ps1 / verify_windows_runtimes.ps1 / tauri-dev-low-mem.ps1
│   ├── setup_linux_runtimes.sh / verify_linux_runtimes.sh / tauri-dev-linux.sh
│   └── build_macos_x64_metal_runtime.sh / build_macos_release.sh
├── bin/llama.cpp/            # Local only (gitignored) — created by setup scripts
├── distribution/             # Packaging docs
├── KNOWLEDGE_CHAT.md
├── MAC_BUILD_GUIDE.md
├── LINUX_BUILD_GUIDE.md
└── ENTERPRISE_SERVER_MODE.md
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No llama-server / chat won’t start | `npm run setup:macos-runtimes` then `npm run verify:macos-runtimes` |
| Wrong arch / “cannot execute binary” | Verify native folder for your Mac; never copy arm64 into x64 folders |
| GPU claimed but not used | Scan runtime; ensure `libggml-metal` exists; Intel: `npm run build:macos-x64-metal` |
| Streaming timed out | Model too large for free RAM; use CPU Safe, smaller GGUF, lower context (2048), or close other apps |
| Empty Knowledge Chat answer | Rebuild index; ask again (file-purpose structured path); check Pipeline diagnostics |
| Embedding server exits immediately | Invalid `.gguf` (HTML download); delete stub and re-download real GGUF |
| Out of memory compiling | `CARGO_BUILD_JOBS=1 npm run tauri:dev:macos` |

---

## Compatibility checklist (ship / handoff)

Before giving this repo to another Mac user:

- [ ] `npm install` succeeds  
- [ ] `npm run setup:macos-runtimes` installs all four folders  
- [ ] `npm run verify:macos-runtimes` passes on **this** machine  
- [ ] On Intel + discrete GPU: Metal build present (`libggml-metal`)  
- [ ] `npm run tauri:dev:macos` launches the app  
- [ ] Runtime scan shows native path + honest GPU status  
- [ ] Chat with a small GGUF works  
- [ ] Knowledge Chat can index a small folder and answer a file-purpose question  

---

## Quick start (Windows)

```powershell
git clone https://github.com/noumanshakeel555-lang/nexus-ai-deep-fixed.git
cd nexus-ai-deep-fixed
npm install
npm run setup:windows-runtimes
npm run verify:windows-runtimes
# Models under D:\PocketMind\models\ (or %LOCALAPPDATA%\PocketMind\models\)
npm run tauri:dev:low-mem
```

Layout:

```text
bin\llama.cpp\cpu\llama-server.exe
bin\llama.cpp\cuda\llama-server.exe      # NVIDIA
bin\llama.cpp\vulkan\llama-server.exe    # AMD/Intel/NVIDIA
```

Default data root: `D:\PocketMind` when drive D: exists, else `%LOCALAPPDATA%\PocketMind`.

ONNX reranker is **off by default** (Qwen3-Reranker GGUF is primary). To enable ONNX fallback on Windows only:

```powershell
# optional: rebuild with onnx-reranker feature
cd src-tauri
cargo build --features custom-protocol,code-entities,onnx-reranker
```

---

## Quick start (Linux)

Prerequisites: Node 18+, Rust 1.70+, build tools for Tauri (`webkit2gtk`, etc. — see Tauri Linux docs), `curl`, `python3`.

```bash
git clone https://github.com/noumanshakeel555-lang/nexus-ai-deep-fixed.git
cd nexus-ai-deep-fixed
npm install
chmod +x scripts/*.sh
npm run setup:linux-runtimes
npm run verify:linux-runtimes
mkdir -p ~/.local/share/PocketMind/models/{llm,embeddings,rerankers}
# Copy GGUFs into that models tree
npm run tauri:dev:linux
```

Layout:

```text
bin/llama.cpp/cpu/llama-server
bin/llama.cpp/cuda/llama-server      # optional
bin/llama.cpp/vulkan/llama-server    # optional
```

Default data root: `~/.local/share/PocketMind` (override with `NEXUS_DATA_ROOT`).

See [`LINUX_BUILD_GUIDE.md`](./LINUX_BUILD_GUIDE.md).

---

## Related docs

- [`MAC_BUILD_GUIDE.md`](./MAC_BUILD_GUIDE.md) — packaging, universal targets, signing notes  
- [`LINUX_BUILD_GUIDE.md`](./LINUX_BUILD_GUIDE.md) — Linux runtimes + Tauri deps  
- [`KNOWLEDGE_CHAT.md`](./KNOWLEDGE_CHAT.md) — RAG deep dive  
- [`ENTERPRISE_SERVER_MODE.md`](./ENTERPRISE_SERVER_MODE.md) — org server mode  
- [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md) — release steps  

---

## License / status

Private project (`"private": true` in `package.json`). Version `0.1.0`.  
Repository: [noumanshakeel555-lang/nexus-ai-deep-fixed](https://github.com/noumanshakeel555-lang/nexus-ai-deep-fixed).
