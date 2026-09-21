# Bundled llama.cpp runtimes (Windows)

This folder is **populated at build time** by:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-windows-bundle-runtimes.ps1
```

It is embedded into the NSIS/MSI installer via `tauri.conf.json` → `bundle.resources`.

Expected layout after prepare:

```text
llama.cpp/
  cpu/llama-server.exe + DLLs
  cuda/llama-server.exe + DLLs   (optional)
  vulkan/llama-server.exe + DLLs (optional)
  BUNDLE_MANIFEST.txt
```

Do not commit the binaries (gitignored). Ship them inside the Store setup.exe only.
