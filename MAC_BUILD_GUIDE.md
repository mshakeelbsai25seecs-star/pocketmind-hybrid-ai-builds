# NexusAI macOS Build Guide

This source is prepared for one shared NexusAI codebase across Windows and macOS. Windows keeps CPU/CUDA/Vulkan runtimes. macOS uses native CPU/Metal llama.cpp runtimes.

## Supported Apple laptop targets

NexusAI should support both active Mac laptop families when the correct runtime folders are bundled:

- **Apple Silicon Macs**: M1, M2, M3, M4 and newer (`arm64` / `aarch64`).
- **Intel Macs**: older MacBook models (`x64` / `x86_64`).

The app detects the running CPU architecture and only launches the matching native runtime. This avoids trying to run an Intel llama-server on Apple Silicon or an Apple Silicon llama-server on Intel.

## Required macOS runtime folders

For a Mac package that works across Apple Silicon and Intel Macs, use this structure:

```text
bin/llama.cpp/macos-arm64-metal/llama-server
bin/llama.cpp/macos-arm64-cpu/llama-server
bin/llama.cpp/macos-x64-metal/llama-server
bin/llama.cpp/macos-x64-cpu/llama-server
```

Legacy folders are still accepted for simple local testing, but the production layout above is preferred:

```text
bin/llama.cpp/macos-metal/llama-server
bin/llama.cpp/macos-cpu/llama-server
```

Inside a packaged `.app`, NexusAI also checks:

```text
NexusAI.app/Contents/Resources/llama.cpp/macos-arm64-metal/llama-server
NexusAI.app/Contents/Resources/llama.cpp/macos-arm64-cpu/llama-server
NexusAI.app/Contents/Resources/llama.cpp/macos-x64-metal/llama-server
NexusAI.app/Contents/Resources/llama.cpp/macos-x64-cpu/llama-server
```

## Download runtimes (recommended)

From the repo root, install **both** architectures automatically:

```bash
npm run setup:macos-runtimes
npm run verify:macos-runtimes
```

This downloads the latest official llama.cpp macOS arm64 + x64 releases into `bin/llama.cpp/`.  
`bin/` is gitignored — every new machine must run the setup script once.

Manual option: download from the llama.cpp releases page (Apple Silicon / Intel), then either place the `.tar.gz` files in `~/Downloads` and re-run the setup script, or extract them yourself into the four folders below.

### Intel Mac GPU (Metal) — required extra step

Official `llama-*-bin-macos-x64.tar.gz` builds are typically **CPU-only** (no `libggml-metal`). Copying that archive into both `macos-x64-metal` and `macos-x64-cpu` will not enable GPU offload.

On an Intel Mac with a discrete Metal GPU (for example AMD Radeon), build and install a real Metal runtime:

```bash
./scripts/build_macos_x64_metal_runtime.sh
```

This replaces `bin/llama.cpp/macos-x64-metal/` with a build that includes `libggml-metal*.dylib`. Then restart NexusAI → **Runtime → Scan runtime** → **Use Automatic Optimizer** (or Calculated Split). The scanner only treats Metal as available when `libggml-metal` is present.

## Simple folder setup on a Mac

From the project root:

```bash
mkdir -p bin/llama.cpp/macos-arm64-metal
mkdir -p bin/llama.cpp/macos-arm64-cpu
mkdir -p bin/llama.cpp/macos-x64-metal
mkdir -p bin/llama.cpp/macos-x64-cpu
```

Copy the extracted Apple Silicon llama.cpp files into both arm64 folders:

```bash
cp -R ~/Downloads/llama-macos-arm64/* bin/llama.cpp/macos-arm64-metal/
cp -R ~/Downloads/llama-macos-arm64/* bin/llama.cpp/macos-arm64-cpu/
```

Copy the extracted Intel llama.cpp files into both x64 folders:

```bash
cp -R ~/Downloads/llama-macos-x64/* bin/llama.cpp/macos-x64-metal/
cp -R ~/Downloads/llama-macos-x64/* bin/llama.cpp/macos-x64-cpu/
```

Then make the servers executable:

```bash
chmod +x bin/llama.cpp/macos-arm64-metal/llama-server
chmod +x bin/llama.cpp/macos-arm64-cpu/llama-server
chmod +x bin/llama.cpp/macos-x64-metal/llama-server
chmod +x bin/llama.cpp/macos-x64-cpu/llama-server
```

## Runtime tests

On Apple Silicon:

```bash
./bin/llama.cpp/macos-arm64-metal/llama-server --help
./bin/llama.cpp/macos-arm64-cpu/llama-server --help
```

On Intel Mac:

```bash
./bin/llama.cpp/macos-x64-metal/llama-server --help
./bin/llama.cpp/macos-x64-cpu/llama-server --help
```

## Build on macOS

For local testing:

```bash
npm install
npm run build
cd src-tauri
cargo check
cd ..
# Prefer this on macOS (skips onnx-reranker — no ort prebuilts for x86_64-apple-darwin):
npm run tauri:dev:macos
# Equivalent: npx tauri dev --no-default-features --features custom-protocol,code-entities
```

Qwen3-Reranker GGUF (primary neural rerank) still works without the ONNX fallback feature.

For a universal Mac app target, build on a Mac with the required Rust targets installed:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

After packaging, confirm the app bundle includes the runtime folders under `Contents/Resources/llama.cpp` or distribute a portable folder that keeps `bin/llama.cpp` beside the app.

## Signing and notarization

For internal testing, an unsigned `.app` or `.dmg` may be enough. For professional distribution outside your own machine, plan for Apple Developer code signing and notarization.
