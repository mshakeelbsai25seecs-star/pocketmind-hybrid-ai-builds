# Recommended server folder layout

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
│   └── intake/          ← company data intake workflow
├── exports/             ← SOC reports, validator output
├── indexes/
│   └── nexus-soc-dense-index.json
└── knowledge-chat/      ← reserved / metadata support
```

Default `{data_root}`:
- Windows Server: `C:\ProgramData\NexusAI`
- Linux: `/var/lib/nexusai`

Intake subfolders (optional, mirror your data pack):
- `intake/policies`, `intake/rules`, `intake/parsers`, `intake/playbooks`, etc.

Do **not** store secrets, credentials, or raw PII in indexed folders.
