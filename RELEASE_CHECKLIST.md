# NexusAI Production Release Checklist

Use this checklist before sharing a tester or production-style build.

## 1. Build validation

- [ ] Run `npm run build` from the project root.
- [ ] Run `cargo check` from `src-tauri` on the Windows build machine.
- [ ] Run `npm run tauri build` from the project root.
- [ ] Confirm `src-tauri/target/release/nexus-ai.exe` exists.
- [ ] Confirm the portable release folder contains `NexusAI.exe`.

## 2. Universal runtime packaging

The portable release should include this structure:

```text
NexusAI_Production_Release
├─ NexusAI.exe
├─ models
└─ bin
   └─ llama.cpp
      ├─ cpu
      │  ├─ llama-server.exe
      │  └─ required CPU DLL files
      ├─ cuda
      │  ├─ llama-server.exe
      │  └─ required CUDA DLL files
      └─ vulkan
         ├─ llama-server.exe
         └─ required Vulkan DLL files
```

- [ ] CPU runtime starts with `llama-server.exe --help`.
- [ ] CUDA runtime starts with `llama-server.exe --help` on an NVIDIA machine.
- [ ] Vulkan runtime starts with `llama-server.exe --help` on a machine with Vulkan drivers.
- [ ] Required DLL files are kept in the same folder as the matching runtime.
- [ ] Runtime folders are not mixed together.

## 3. First-run checks

- [ ] App opens maximized.
- [ ] Setup Wizard opens or can be opened manually.
- [ ] Diagnostics page shows pass/warn/fail states clearly.
- [ ] Runtime page can scan bundled runtimes.
- [ ] CPU Safe profile applies GPU layers 0 for validation and troubleshooting.
- [ ] Automatic Optimizer is the default profile and applies GPU layers -1.
- [ ] Missing runtime folders show clear guidance instead of crashing.

## 4. Local model checks

- [ ] Import a small GGUF model such as TinyLlama, Phi-3 Mini, or Qwen small.
- [ ] Select the model with Use in Chat.
- [ ] Run Model Health Check.
- [ ] Start a new chat and send: `Say hello in one sentence.`
- [ ] Confirm the answer is direct and not repeated boilerplate.
- [ ] Test Stop while a response is running.

## 5A. Automatic optimization checks

- [ ] Runtime page shows Automatic Optimizer as the active/default mode.
- [ ] GPU layers `-1` is accepted as Auto mode.
- [ ] With a selected local GGUF model, Runtime scan shows an automatic fit status.
- [ ] On strong GPU machines, Auto mode attempts full GPU offload first.
- [ ] On limited GPU machines, Auto mode attempts CPU + GPU split before CPU fallback.
- [ ] On CPU-only machines, Auto mode falls back safely to CPU.
- [ ] Large models such as 70B remain visible in the catalog for qualified enterprise hardware.
- [ ] If a model cannot fit available memory, NexusAI displays a clear fit/runtime error instead of crashing.

## 5. GPU validation checks

For NVIDIA machines:

- [ ] Run `nvidia-smi` before opening NexusAI.
- [ ] Open Runtime and scan.
- [ ] Use Automatic Optimizer first, then verify it selects GPU or CPU+GPU split when hardware supports it.
- [ ] Generate a response while watching `nvidia-smi -l 1`.
- [ ] Confirm GPU memory or utilization changes during generation.

For CPU-only machines:

- [ ] Runtime scan should not fail.
- [ ] CPU Safe mode should work.
- [ ] Chat should work with a small model.

For AMD/Intel/Vulkan machines:

- [ ] Vulkan runtime folder exists.
- [ ] Runtime scan reports Vulkan information when available.
- [ ] If Vulkan fails, NexusAI should fall back to CPU with a clear message.

## 6. Chat management

- [ ] New chat creates successfully.
- [ ] First user message automatically renames the chat.
- [ ] Three-dot menu supports Rename, Copy chat, and Delete.
- [ ] Delete confirmation appears.
- [ ] Sidebar remains scrollable on smaller screens.

## 7. Characters

- [ ] Add all common characters.
- [ ] Use Character applies a persona to the next chat.
- [ ] New Chat from a character opens with that character active.
- [ ] Chat header shows the active character.
- [ ] Legal and medical personas remain educational and do not claim to replace professionals.

## 8. Attachments

- [ ] Attach TXT, PDF, DOCX, CSV, JSON, or code files.
- [ ] Attachment chips appear above the composer.
- [ ] Extraction warnings appear when relevant.
- [ ] Unsupported or scanned/image-only files do not crash the app.
- [ ] File context is used by the model without dumping raw context into the visible chat.

## 9. Image Studio

- [ ] Free online image generation shows a loading state and then an image or clear error.
- [ ] Image cards stay inside their frames.
- [ ] Open, Copy URL, Retry, and Save actions are visible where supported.
- [ ] Offline image models are honestly labeled as catalog/planning entries unless a local image runtime is installed.

## 10. Backup, storage, and help

- [ ] Backup exports JSON successfully.
- [ ] Backup import adds records without overwriting everything.
- [ ] Storage page shows local model records and chat counts.
- [ ] Help Center explains model, runtime, API key, GPU, download, and attachment issues clearly.

## Release decision

Only share the build when local chat, runtime scan, model health check, chat management, and diagnostics pass on the build machine. GPU acceleration should be treated as validated only after real hardware testing confirms it.


macOS readiness notes:
- The same source code can be built on macOS with Tauri.
- Final macOS .app/.dmg bundles must be built on a Mac or macOS CI runner.
- For Apple Silicon acceleration, bundle a Metal-enabled llama.cpp runtime in bin/llama.cpp/macos-metal or in NexusAI.app/Contents/Resources/llama.cpp/macos-metal.
- For safe macOS fallback, bundle a CPU llama.cpp runtime in bin/llama.cpp/macos-cpu or in NexusAI.app/Contents/Resources/llama.cpp/macos-cpu.
- Windows runtime folders remain cpu, cuda, and vulkan.
- GPU acceleration should be verified with Runtime → Scan runtime and a real generation test on target hardware.

macOS universal runtime note:
Bundle native Apple Silicon and Intel runtimes separately so one Mac source/release can support both Mac families:
- bin/llama.cpp/macos-arm64-metal/llama-server
- bin/llama.cpp/macos-arm64-cpu/llama-server
- bin/llama.cpp/macos-x64-metal/llama-server
- bin/llama.cpp/macos-x64-cpu/llama-server
NexusAI selects only the matching native runtime for the current Mac and falls back safely to CPU.

## Organization Server Mode Checklist

- [ ] Organization Server page opens.
- [ ] Internal server URL can be saved.
- [ ] Access token can be saved and removed.
- [ ] Test connection works against an OpenAI-compatible `/v1/models` endpoint.
- [ ] Server models are listed correctly.
- [ ] Selecting a server model creates a new server chat.
- [ ] Chat responses stream from `/v1/chat/completions`.
- [ ] Local model mode still works after testing server mode.
- [ ] Online provider mode still works after testing server mode.
- [ ] Server unavailable error is clear and does not crash the app.## Enterprise server pilot checklist

- [ ] `enterprise-server/README_START_HERE.md` reviewed.
- [ ] Server hardware report generated with `enterprise-server/scripts/detect_server.sh`.
- [ ] Deployment profile selected from `DEPLOYMENT_DECISION_TREE.md`.
- [ ] Security checklist reviewed with company IT.
- [ ] Server endpoint exposes `/v1/models`.
- [ ] Server endpoint supports `/v1/chat/completions` streaming.
- [ ] NexusAI Organization Server connection test passes.
- [ ] Server model appears in NexusAI.
- [ ] Server chat streams response correctly.
- [ ] Pilot users understand allowed document/data policy.
- [ ] CPU/GPU utilization monitored during pilot.
- [ ] Admin handover guide completed after pilot.
