# PocketMind Hybrid AI Linux Build Guide

Shared codebase with Windows and macOS. Linux uses the same `bin/llama.cpp/{cpu,cuda,vulkan}` layout as Windows (ELF binaries, no `.exe`).

## Prerequisites

- Ubuntu 22.04+ / Debian-like (or equivalent)
- Node.js 18+
- Rust 1.70+ (`rustup`)
- Tauri Linux system deps (webkit2gtk, etc.):  
  https://v1.tauri.app/v1/guides/getting-started/prerequisites/
- `curl`, `python3`, `tar`, `file`

Example (Ubuntu/Debian — adjust for your distro):

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.0-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf python3
```

## Install runtimes

```bash
chmod +x scripts/*.sh
npm run setup:linux-runtimes
npm run verify:linux-runtimes
```

Optional env:

```bash
SKIP_CUDA=1 npm run setup:linux-runtimes     # CPU (+ Vulkan if available)
SKIP_VULKAN=1 npm run setup:linux-runtimes
./scripts/setup_linux_runtimes.sh b9981      # pin a llama.cpp release tag
```

## Models & data

```bash
export NEXUS_DATA_ROOT="${NEXUS_DATA_ROOT:-$HOME/.local/share/PocketMind}"
mkdir -p "$NEXUS_DATA_ROOT/models/llm" \
         "$NEXUS_DATA_ROOT/models/embeddings" \
         "$NEXUS_DATA_ROOT/models/rerankers"
```

Place GGUFs (same names as Windows/Mac):

- Chat: e.g. `Phi-3-mini-…gguf` under `models/llm/`
- Code embed: `Qwen3-Embedding-8B-Q4_K_M.gguf`
- Doc embed: `bge-m3-Q4_K_M.gguf`
- Rerank: `Qwen3-Reranker-4B-Q4_K_M.gguf`

## Dev

```bash
npm install
npm run tauri:dev:linux
```

Notes:

- Default Cargo features exclude `onnx-reranker` (no reliable ort prebuilts on all Linux arches). Primary rerank is Qwen GGUF.
- Metal does not apply on Linux; use CUDA and/or Vulkan.
- First compile can take a long time.

## Checklist

- [ ] `npm run setup:linux-runtimes` installs at least `cpu`
- [ ] `npm run verify:linux-runtimes` passes
- [ ] `npm run tauri:dev:linux` launches
- [ ] Runtime scan finds `bin/llama.cpp/...`
- [ ] Chat + Knowledge Chat work with local GGUFs
