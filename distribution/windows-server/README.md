# NexusAI — Windows Server Package

Enterprise handoff kit for Windows Server SOC pilots. Includes admin documentation, configuration templates, and folder preparation scripts.

## Contents

| Path | Purpose |
|------|---------|
| `docs/USER_MANUAL.md` | Analyst guide |
| `docs/ADMIN_DEPLOYMENT_GUIDE.md` | IT install and rollout |
| `docs/CONFIGURATION.md` | Paths, env vars, performance |
| `docs/TROUBLESHOOTING.md` | Common issues |
| `config/deployment.env.example` | Environment template |
| `config/folder-layout.md` | Directory structure |
| `scripts/prepare-server.ps1` | Create `C:\ProgramData\NexusAI` tree |

## Application binary

Copy the staged Windows desktop payload from `../windows-desktop/payload/` or build with `npm run tauri build` and stage via `../windows-desktop/scripts/stage-release.ps1`.

## Quick start (admin)

```powershell
.\scripts\prepare-server.ps1 -DataRoot "C:\ProgramData\NexusAI"
# Copy NexusAI.exe + bin\llama.cpp into install folder
# Copy models and company-data
# Launch app → Settings → Deployment → Save
```

Default data root: `C:\ProgramData\NexusAI`

See also `../shared/docs/QUICK_START.md`.
