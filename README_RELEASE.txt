NexusAI Desktop Release Package

NexusAI is an offline-first desktop AI workspace for local GGUF chat, online model providers, file context, characters, image workflows, diagnostics, storage, and backup/restore.

How to run:
1. Extract the release ZIP.
2. Open NexusAI.exe.
3. Complete Setup Wizard if shown.
4. Open Runtime and click Scan runtime.
5. Open Diagnostics and run checks.
6. Open Models and import or download a GGUF chat model.
7. Select the model with Use in Chat.
8. Run Model Health Check.
9. Open Chat and start a new conversation.

Recommended first local models:
- TinyLlama for very low RAM validation.
- Phi-3 Mini for balanced small-model testing.
- Qwen small instruct models for general chat and study.
- Mistral 7B Instruct Q4 for higher-quality local chat on stronger machines.

Recommended first settings:
- Creativity: 0.4 to 0.5
- Response tokens: 128 to 256
- Context: 2048
- Batch: 128
- Repeat penalty: 1.18 or higher
- GPU layers: -1 for Automatic Optimizer; use 0 only for CPU-safe validation

Universal runtime layout:
For full CPU, CUDA, and Vulkan auto-selection, the release should include:

bin\llama.cpp\cpu\llama-server.exe
bin\llama.cpp\cuda\llama-server.exe
bin\llama.cpp\vulkan\llama-server.exe

Keep each runtime's required DLL files inside the same folder as that runtime. Do not mix DLL files between CPU, CUDA, and Vulkan folders.

Automatic optimizer:
- GPU layers `-1` means NexusAI decides automatically.
- Auto mode tries full GPU offload first, then calculated CPU + GPU split, then CPU fallback.
- Large 70B-class models remain available for organizations with enough RAM/VRAM; unsupported machines should receive a clear fit or runtime message.

GPU notes:
- CPU-only systems are fully supported.
- NVIDIA acceleration requires the CUDA runtime folder and working NVIDIA drivers.
- AMD/Intel/NVIDIA Vulkan acceleration requires the Vulkan runtime folder and working Vulkan drivers.
- If GPU startup fails, NexusAI should fall back to CPU instead of crashing.
- GPU acceleration is confirmed only when Runtime diagnostics and real generation tests show GPU activity.

Online providers:
Online chat and premium image providers require user-provided API keys. API keys are stored locally and are not included in backups.

Attachments:
NexusAI extracts supported file text locally. Scanned PDFs and image understanding require OCR or vision support; when unavailable, NexusAI should show a limitation message instead of crashing.

Privacy:
Local GGUF chat and local file extraction remain on the user's computer. Online provider requests are sent to the selected provider only when the user chooses an online model.

Known partial features:
- Free online image generation is supported through the configured free provider workflow.
- Offline image generation models are listed for catalog and planning unless a separate local image runtime is installed and wired.
- GPU acceleration depends on the bundled runtime folders and the user's installed drivers.

Tester feedback to collect:
1. Screenshot of Runtime scan.
2. Screenshot of Diagnostics.
3. Selected model name and size.
4. GPU name, if any.
5. `nvidia-smi` screenshot during generation on NVIDIA machines.
6. Any visible NexusAI error message.
7. Whether chat, attachments, image generation, and backup worked.


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

Organization Server Mode
------------------------
NexusAI can also connect to a company-owned OpenAI-compatible AI server. This is designed for organizations that want employees to use the NexusAI desktop app while large models run on internal GPU servers.

Supported endpoint shape:
- GET  /v1/models
- POST /v1/chat/completions with streaming responses

Recommended server engines:
- vLLM for high-throughput multi-GPU deployments
- Hugging Face Text Generation Inference for production transformer serving
- llama.cpp server for GGUF deployments

In the app, open Organization Server, enter the private endpoint, test the connection, load models, and choose a server model. NexusAI will create a new server chat and stream responses from the organization server.## Enterprise Server Deployment Kit

This release includes an `enterprise-server` folder for organization-wide deployment. The desktop app is the client; the company server runs the large model.

Use cases:

- Private AI server for employees.
- Large models on GPU workstations or multi-GPU servers.
- Company LAN/VPN endpoint for Windows, macOS, and Android clients.
- OpenAI-compatible server engines such as vLLM, Ollama, llama.cpp server, TGI, or an internal AI gateway.

Start with:

```text
enterprise-server/README_START_HERE.md
enterprise-server/DEPLOYMENT_DECISION_TREE.md
enterprise-server/SECURITY_CHECKLIST.md
enterprise-server/PILOT_TESTING_CHECKLIST.md
```

NexusAI Organization Server Mode expects:

```text
GET  /v1/models
POST /v1/chat/completions
```

Recommended enterprise path: Ubuntu + NVIDIA GPU(s) + Docker + vLLM.
