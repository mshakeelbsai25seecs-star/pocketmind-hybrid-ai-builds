# PocketMind Hybrid AI Configuration Reference

## In-app configuration

**Settings → Deployment** persists all values to the local SQLite settings store.

### Data locations

| Setting | Default (Windows Server) | Description |
|---------|--------------------------|-------------|
| Data root | `C:\ProgramData\PocketMind` | Parent for all PocketMind Hybrid AI data |
| Models directory | `{data_root}\models` | Chat GGUF files |
| Embedding model | `{data_root}\models\embeddings\nomic-embed-text-v1.5.Q4_K_M.gguf` | Knowledge Chat / SOC retrieval |
| Company SOC data root | `{data_root}\company-data` | Grounded knowledge collection |
| Intake subfolder | `intake` | Company data intake under SOC root |
| Export directory | `{data_root}\exports` | Reports and validator exports |
| Dense index path | `{data_root}\indexes\nexus-soc-dense-index.json` | Legacy dense index file |

### Performance (server preset)

| Setting | Server default | Workstation default |
|---------|----------------|---------------------|
| Context size | 8192 | 4096 |
| Max tokens | 1024 | 512 |
| GPU layers | -1 (auto) | -1 (auto) |
| Batch size | 256 | 128 |
| Retrieval top-K | 12 | 8 |
| Embed context | 2048 | 2048 |
| Max snippet chars | 1600 | 1400 |

### Deployment modes

- **server** — higher context and response limits for shared analyst hosts.
- **workstation** — balanced defaults for single-user machines.

Use **Apply server performance preset** or **Apply workstation preset** in the Deployment settings UI.

## Environment variables

Environment variables override defaults on startup (see `deployment.env.example`).

```
NEXUS_DATA_ROOT=C:\ProgramData\PocketMind
NEXUS_MODELS_DIR=C:\ProgramData\PocketMind\models
NEXUS_SOC_DATA_ROOT=C:\ProgramData\PocketMind\company-data
NEXUS_EXPORT_DIR=C:\ProgramData\PocketMind\exports
NEXUS_EMBEDDING_MODEL=C:\ProgramData\PocketMind\models\embeddings\nomic-embed-text-v1.5.Q4_K_M.gguf
NEXUS_CONTEXT_SIZE=8192
NEXUS_MAX_TOKENS=1024
NEXUS_DEPLOY_MODE=server
NEXUS_ALLOWED_PATHS=;extra read-only roots separated by semicolon
```

## Path security

SOC scan, export, OCR, and embedding model paths must fall under configured data roots. This replaces the old D-drive-only prototype restriction.

## Application database

User conversations and deployment settings: `%APPDATA%\PocketMind Hybrid AI\app.db` (Windows) or equivalent on Linux.

Knowledge Chat collection index: stored in app database; source files remain on disk under `company-data`.
