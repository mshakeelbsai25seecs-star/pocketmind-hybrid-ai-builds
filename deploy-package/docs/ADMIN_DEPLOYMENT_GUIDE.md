# NexusAI Admin Deployment Guide

## Overview

Deploy NexusAI as an offline SOC copilot on a dedicated Windows Server or Linux host. Analysts connect via RDP/remote desktop or distributed desktop installs pointing at shared data paths.

## Hardware guidelines

| Role | Minimum | Recommended |
|------|---------|---------------|
| CPU | 8 cores | 16+ cores |
| RAM | 32 GB | 64–128 GB |
| GPU | Optional (CPU works) | NVIDIA 24GB+ VRAM for larger models |
| Disk | 200 GB free | 500 GB+ SSD for models + company data |

## Installation steps

### 1. Build or copy the application

From the development machine:
```powershell
npm install
npm run tauri build
```
Deliver the release bundle from `src-tauri/target/release/` plus `bin/llama.cpp/` runtimes per `RELEASE_CHECKLIST.md`.

### 2. Prepare server directories

**Windows Server (PowerShell as Administrator):**
```powershell
.\deploy-package\scripts\prepare-windows-server.ps1 -DataRoot "C:\ProgramData\NexusAI"
```

**Linux:**
```bash
sudo bash deploy-package/scripts/prepare-linux-server.sh /var/lib/nexusai
```

### 3. Install models

| File | Location |
|------|----------|
| Chat model (GGUF) | `{data_root}/models/` |
| Embedding model | `{data_root}/models/embeddings/nomic-embed-text-v1.5.Q4_K_M.gguf` |

### 4. Install company data

Place sanitized SOC policies, SOPs, runbooks under:
```
{data_root}/company-data/
{data_root}/company-data/intake/   ← optional intake workflow
```

### 5. Configure environment (optional)

Copy `deploy-package/config/deployment.env.example` and set on the server or service account:

| Variable | Purpose |
|----------|---------|
| `NEXUS_DATA_ROOT` | Root for all NexusAI data |
| `NEXUS_MODELS_DIR` | GGUF models folder |
| `NEXUS_SOC_DATA_ROOT` | Company knowledge for SOC |
| `NEXUS_EXPORT_DIR` | Default export folder |
| `NEXUS_EMBEDDING_MODEL` | Path to embedding GGUF |
| `NEXUS_CONTEXT_SIZE` | LLM context window |
| `NEXUS_MAX_TOKENS` | Max response length |
| `NEXUS_DEPLOY_MODE` | `server` for higher limits |

### 6. First launch checklist

1. Start NexusAI.
2. **Settings → Deployment** → verify paths → **Save deployment settings**.
3. **Models** → scan folder → import GGUF.
4. **Fortinet Copilot → Grounded SOC Knowledge** → Link Collection → Scan & Index.
5. Run a test triage with demo sample or real sanitized alert.
6. Export a test report to `{data_root}/exports/`.

### 7. Enterprise LLM server (optional)

If using a shared OpenAI-compatible inference server instead of local GGUF, configure **Enterprise Server** in the app and deploy using `enterprise-server/` kit in the repo.

## Security

- Keep company data on controlled server paths only.
- Do not place credentials in indexed folders.
- Restrict file share permissions to SOC role groups.
- Review `enterprise-server/SECURITY_CHECKLIST.md` if exposing an API.

## Rollout to analysts

1. Distribute `docs/USER_MANUAL.md`.
2. Provide model name and shared data root (if using shared storage).
3. Confirm each workstation can reach the configured paths.
4. Run pilot using `enterprise-server/PILOT_TESTING_CHECKLIST.md` patterns.
