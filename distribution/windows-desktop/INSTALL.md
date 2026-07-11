# Install NexusAI on Windows (desktop)

## Requirements

- Windows 10 or 11 (64-bit)
- 16 GB RAM minimum (32 GB+ recommended for larger models)
- Optional: NVIDIA GPU with recent drivers for CUDA acceleration

## Steps

1. Extract the zip to a folder such as `C:\NexusAI\`.
2. Open `payload\NexusAI.exe` (or the portable folder exe after staging).
3. If Windows SmartScreen appears, choose **More info → Run anyway** (signed builds skip this).
4. On first launch: **Settings → Deployment** → verify paths → **Save**.
5. Copy GGUF models to the configured `models\` folder.
6. Copy company SOC data to `company-data\`.
7. **Fortinet Copilot → Grounded SOC Knowledge** → Scan & Index.

## WebView2

Tauri bundles WebView2. If the app fails to start, install the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

## GPU acceleration

1. **Runtime** page → scan bundled runtimes.
2. Use **Automatic Optimizer** (default) or **CPU Safe** for troubleshooting.
3. Confirm `bin\llama.cpp\cuda\llama-server.exe` exists for NVIDIA machines.

## Uninstall

Delete the install folder. App data remains under `C:\ProgramData\NexusAI` unless you remove it manually.

## Support docs

- `../shared/docs/QUICK_START.md`
- Server rollout: `../windows-server/docs/USER_MANUAL.md`
