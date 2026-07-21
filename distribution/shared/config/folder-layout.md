# Recommended folder layout

```
{data_root}/
├── models/
│   ├── chat-model-name.Q4_K_M.gguf
│   └── embeddings/
│       └── nomic-embed-text-v1.5.Q4_K_M.gguf
├── company-data/
│   ├── policies/
│   ├── sops/
│   ├── runbooks/
│   ├── sample-logs/
│   └── intake/
├── exports/
├── indexes/
│   └── nexus-soc-dense-index.json
└── knowledge-chat/
```

## Default `{data_root}` by platform

| Platform | Default |
|----------|---------|
| Windows | `C:\ProgramData\PocketMind` |
| Linux | `/var/lib/pocketmind` |
| macOS workstation | `~/Library/Application Support/PocketMind` |
| macOS server | `/Library/Application Support/PocketMind` |

Intake subfolders mirror your data pack: `intake/rules`, `intake/parsers`, `intake/playbooks`, etc.

Do **not** store secrets, credentials, or raw PII in indexed folders.
