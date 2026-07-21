# PocketMind Hybrid AI Configuration Reference

## In-app configuration

**Settings → Deployment** persists all values to the local SQLite settings store.

### Data locations

| Setting | Windows default | Linux default | macOS default |
|---------|-----------------|---------------|---------------|
| Data root | `C:\ProgramData\PocketMind` | `/var/lib/pocketmind` | `~/Library/Application Support/PocketMind` |
| Models | `{data_root}/models` | same | same |
| Embedding model | `{data_root}/models/embeddings/...gguf` | same | same |
| Company data | `{data_root}/company-data` | same | same |
| Exports | `{data_root}/exports` | same | same |

### Performance presets

- **server** — higher context and response limits.
- **workstation** — balanced single-user defaults.

## Environment variables

See `config/deployment.env.example`. Key variables:

- `NEXUS_DATA_ROOT` — overrides default data root on all platforms
- `NEXUS_DEPLOY_MODE=server` — server performance preset
- `NEXUS_ALLOWED_PATHS` — extra read roots (`;` on Windows, `:` on Unix)

## Path security

SOC scan, export, OCR, and embedding paths must fall under configured deployment roots.
