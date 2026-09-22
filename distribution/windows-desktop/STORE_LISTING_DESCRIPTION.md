# Microsoft Store — Listing Description (paste into Partner Center)

Product ID: `9NZ7WF9VXF5R`  
Product name: PocketMind AI  
Package version target: **1.0.3.0**

## Description (English) — paste exactly

**Policy 10.2.4.1:** the Microsoft Visual C++ dependency must appear in the **first two lines**.

```text
Requires Microsoft Visual C++ Redistributable (x64). Install from Microsoft if Windows prompts for missing VC++ runtime DLLs.
This Store package includes PocketMind AI and a CPU local-inference runtime. Optional GPU acceleration (CUDA/Vulkan) can be added after install from the app’s Runtime Manager if your hardware supports it. No kernel drivers or Windows services are installed.

PocketMind AI is a local-first hybrid AI desktop app for chat, coding help, documents, and images. Run offline GGUF models on your PC, or optionally connect cloud providers and organization servers you control.

Features
- Private chat workspace with local models and on-device privacy
- Models library (Local GGUF) plus optional OpenAI, Anthropic, Gemini, Groq, and organization servers
- PocketCode IDE agent with git diffs, terminal, Problems/Output/Debug Console, plan mode, and MCP tools
- Fortinet SOC Copilot with investigations, evidence, validators, and Review & Approve
- Image Studio for AI image generation, compare, and export
- Characters for reusable roles and prompts
- Hardware & Runtime Manager (CPU-safe optimizer; optional post-install GPU runtimes)
- Control Center for diagnostics, API keys, audit log, backups, deployment, and organization
- Document Studio for DOCX / PPTX / PDF export on this PC

Generative AI
PocketMind uses live generative AI. Review outputs before relying on them. Use in-app Report controls on AI answers and images, or email support.pocketmind@gmail.com, to report inappropriate AI-generated content.

System notes
- Windows 10/11 Desktop x64
- GGUF model weights are not bundled; import your own models for local generation
- WebView2 Runtime is required (usually already present on modern Windows)
```

## Short description / subtitle (if a separate field exists)

```text
Local-first hybrid AI for chat, coding, documents, and images on Windows.
```

## What changed for certification / store-parity

| Policy / change | Fix |
|-----------------|-----|
| **10.2.4.1** | First two lines disclose Microsoft Visual C++ Redistributable |
| **11.16** | In-app Report AI content (Chat, Image Studio, Document Studio, Help, Settings) + email `support.pocketmind@gmail.com` |
| **10.1.2.7** | Publisher updates the privacy policy URL so it resolves (out of band) |
| **Store parity 1.0.3.0** | Listing features match shipped surfaces (PocketCode, Model Manager, SOC, Control Center, Characters, Hardware); Knowledge Chat removed from primary UX |
