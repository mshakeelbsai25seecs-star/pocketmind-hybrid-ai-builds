# NexusAI Admin Deployment Guide

## Overview

Deploy NexusAI as an offline SOC copilot on Windows Server, Linux, or macOS server hosts. Analysts connect via RDP/remote desktop or distributed desktop installs pointing at shared data paths.

## Hardware guidelines

| Role | Minimum | Recommended |
|------|---------|---------------|
| CPU | 8 cores | 16+ cores |
| RAM | 32 GB | 64–128 GB |
| GPU | Optional (CPU works) | NVIDIA 24GB+ VRAM for larger models |
| Disk | 200 GB free | 500 GB+ SSD for models + company data |

## Installation steps

### 1. Build or copy the application

See `distribution/scripts/BUILD_ALL.md` in the repo. Deliver the release bundle plus `bin/llama.cpp/` runtimes per `RELEASE_CHECKLIST.md`.

### 2. Prepare server directories

**Windows Server:**
```powershell
.\distribution\windows-server\scripts\prepare-server.ps1 -DataRoot "C:\ProgramData\NexusAI"
```

**Linux:**
```bash
sudo bash distribution/linux-server/scripts/prepare-server.sh /var/lib/nexusai
```

**macOS server:**
```bash
sudo bash distribution/macos-server/scripts/prepare-server.sh "/Library/Application Support/NexusAI"
```

### 3. Install models

| File | Location |
|------|----------|
| Chat model (GGUF) | `{data_root}/models/` |
| Embedding model | `{data_root}/models/embeddings/nomic-embed-text-v1.5.Q4_K_M.gguf` |

### 4. Install company data

Place sanitized SOC policies, SOPs, runbooks under `{data_root}/company-data/` and optional `{data_root}/company-data/intake/`.

### 5. Configure environment (optional)

Copy `config/deployment.env.example` and set on the server or service account.

### 6. First launch checklist

1. Start NexusAI.
2. **Settings → Deployment** → verify paths → **Save**.
3. **Models** → scan folder → import GGUF.
4. **Fortinet Copilot → Grounded SOC Knowledge** → Link → Scan & Index.
5. Run a test triage.
6. Export a test report to `{data_root}/exports/`.

## Security

- Keep company data on controlled server paths only.
- Do not place credentials in indexed folders.
- Restrict file share permissions to SOC role groups.

## Rollout to analysts

1. Distribute `docs/USER_MANUAL.md`.
2. Provide model name and shared data root.
3. Confirm each workstation can reach configured paths.
