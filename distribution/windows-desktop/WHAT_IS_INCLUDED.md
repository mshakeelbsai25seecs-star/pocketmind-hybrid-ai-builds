# What is included (Windows desktop)

After running `scripts/stage-release.ps1`, `payload/` should contain:

```text
payload/
├── NexusAI.exe              # Main application (name may match tauri bundle)
├── WebView2 / MSVC deps     # Bundled by Tauri NSIS/portable target
├── bin/
│   └── llama.cpp/
│       ├── cpu/
│       ├── cuda/
│       └── vulkan/
└── models/                  # Empty placeholder — customer adds GGUF files
```

## You must supply separately

- Chat GGUF models → `models/`
- Embedding GGUF → `models/embeddings/`
- Company SOC documents → configured `company-data/` path

## Not included

- Internet API keys (optional online chat providers)
- Live FortiSIEM / FortiSOAR connectors
