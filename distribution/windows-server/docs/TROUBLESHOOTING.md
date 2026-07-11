# NexusAI Troubleshooting

## App won't start

| Symptom | Check |
|---------|--------|
| Missing DLL / runtime | Install platform redistributables; bundle `bin/llama.cpp` per release checklist |
| Database error | Ensure app data directory is writable |
| Blank window | Run from terminal; check GPU drivers |

## No model available

1. **Models** → verify **Models directory** in Settings → Deployment.
2. Place `.gguf` files in that folder.
3. **Scan folder** and import.

## SOC answers don't use company policies

1. **Grounded SOC Knowledge** → status **Ready**, chunks > 0.
2. **Scan & Index** after adding files.
3. Ensure **Auto-retrieve** is enabled.
4. Files under configured `company-data` path.

## Path rejected

Move files under configured data roots or add `NEXUS_ALLOWED_PATHS`.

## Slow generation

Reduce context/max tokens, use smaller quantization, enable GPU runtime.

## Export fails

Export path must be under `export_dir`. Extensions: `.md`, `.txt`, `.json`, `.xml`.

## Escalation

Provide admin: deployment paths, model name, index chunk count, exact error message.
