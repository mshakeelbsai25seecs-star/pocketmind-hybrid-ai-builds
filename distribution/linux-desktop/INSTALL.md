# Install NexusAI on Linux (desktop)

## Requirements

- Ubuntu 22.04+ or equivalent glibc-based distro
- 16 GB RAM minimum
- Optional: Vulkan drivers for GPU offload

## AppImage

```bash
chmod +x NexusAI_*.AppImage
./NexusAI_*.AppImage
```

## Debian package

```bash
sudo dpkg -i nexus-ai_*.deb
sudo apt-get install -f   # if dependencies missing
nexus-ai
```

## First-run setup

1. **Settings → Deployment** → paths → **Save**
2. Create data folders: `sudo mkdir -p /var/lib/nexusai && sudo chown $USER /var/lib/nexusai` (or use home directory via env)
3. Add models and company data
4. Scan & index in Fortinet Copilot

## Environment (optional)

```bash
export NEXUS_DATA_ROOT=$HOME/.local/share/nexusai
```
