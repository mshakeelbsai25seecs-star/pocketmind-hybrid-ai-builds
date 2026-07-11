# NexusAI Troubleshooting

## App won't start

| Symptom | Check |
|---------|--------|
| Missing DLL / runtime | Install VC++ redistributable; bundle `bin/llama.cpp` per release checklist |
| Database error | Ensure `%APPDATA%\NexusAI` is writable |
| Blank window | Run from terminal to see logs; check GPU drivers |

## No model available

1. Open **Models** → verify **Models directory** in Settings → Deployment.
2. Place `.gguf` files in that folder.
3. Click **Scan folder** and import.

## SOC answers don't use company policies

1. **Grounded SOC Knowledge** → status must be **Ready** with chunks > 0.
2. Click **Scan & Index** or **Rebuild Index** after adding files.
3. Ensure **Auto-retrieve** is enabled.
4. Verify company files are under configured `company-data` path.

## "Path is outside configured NexusAI data roots"

1. Open **Settings → Deployment**.
2. Move files under `data_root` or add path to `NEXUS_ALLOWED_PATHS`.
3. Save deployment settings.

## Knowledge Chat "not found" answers

- Rephrase the question.
- Rebuild index after OCR or PDF changes.
- Confirm the question topic exists in indexed files (e.g. HR policies won't answer if only SOC SOPs are indexed).

## Slow generation

| Action | Effect |
|--------|--------|
| Reduce context size / max tokens | Faster, shorter answers |
| Use smaller GGUF quantization (Q4) | Less VRAM, faster |
| Enable GPU runtime (`bin/llama.cpp/cuda`) | Much faster on NVIDIA |
| Server preset | Already tuned for throughput |

## Embedding / dense search fails

1. Confirm embedding GGUF exists at configured path.
2. Validate in SOC Knowledge Base dense provider section.
3. Re-index collection with **build dense** enabled.

## Export fails

- Export path must be under configured `export_dir`.
- Use `.md`, `.txt`, `.json`, or `.xml` extension.

## Enterprise server connection fails

1. Verify URL ends with `/v1` (e.g. `http://server:8000/v1`).
2. Test connection in **Enterprise Server** view.
3. Check firewall and TLS if using HTTPS.

## Getting logs

- Run app from command line for stderr output.
- **Settings → Advanced → Generate Debug Report** (when available).
- **Diagnostics** view for runtime health.

## Escalation

Provide admin: deployment paths screenshot, model name, index chunk count, and exact error message.
