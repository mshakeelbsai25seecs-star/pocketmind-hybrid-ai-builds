# NexusAI Universal Distribution Bundle

This folder is the **master package of packages** for shipping NexusAI on every supported platform. Each subfolder is a self-contained deliverable with its own install guide, payload area, and scripts.

## Choose your package

| Package | Audience | What you get |
|---------|----------|--------------|
| [`windows-desktop/`](windows-desktop/README.md) | Windows 10/11 workstations | Portable `.exe` + runtimes + local docs |
| [`macos-desktop/`](macos-desktop/README.md) | macOS workstations (Intel + Apple Silicon) | `.app` / `.dmg` staging + Metal/CPU runtimes |
| [`linux-desktop/`](linux-desktop/README.md) | Linux desktops | AppImage / `.deb` staging + CPU/Vulkan runtimes |
| [`windows-server/`](windows-server/README.md) | Windows Server pilots | App + admin docs + folder prep scripts |
| [`linux-server/`](linux-server/README.md) | Linux server pilots | App + admin docs + folder prep scripts |
| [`macos-server/`](macos-server/README.md) | macOS server / shared Mac | App + admin docs + folder prep scripts |
| [`shared/`](shared/docs/QUICK_START.md) | All platforms | Config templates, quick start, company-data layout |

## Build workflow (maintainers)

1. Read [`scripts/BUILD_ALL.md`](scripts/BUILD_ALL.md).
2. Build on the **target OS** (or CI runner for that OS): `npm run tauri build`.
3. Run the matching stage script to copy artifacts into the package `payload/` folder.
4. Zip the platform folder (e.g. `NexusAI-Windows-Desktop-v0.1.0.zip`) and ship with models/docs as needed.

## Default data paths (all platforms)

Paths are configurable in **Settings → Deployment** or via environment variables (see `shared/config/deployment.env.example`).

| OS | Default data root |
|----|-------------------|
| Windows | `C:\ProgramData\NexusAI` |
| Linux | `/var/lib/nexusai` |
| macOS (workstation) | `~/Library/Application Support/NexusAI` |
| macOS (server mode) | `/Library/Application Support/NexusAI` |

Override with `NEXUS_DATA_ROOT`.

## Version

See [`PRODUCTION_READINESS.md`](../PRODUCTION_READINESS.md) for pilot enablement (production mode, audit log, eval).
