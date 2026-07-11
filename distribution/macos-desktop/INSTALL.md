# Install NexusAI on macOS (desktop)

## Requirements

- macOS 12 Monterey or newer
- Apple Silicon or Intel Mac
- 16 GB RAM minimum

## Steps

1. Open the `.dmg` and drag **NexusAI** to Applications (after staging).
2. First launch: right-click → **Open** if Gatekeeper blocks unsigned builds.
3. **Settings → Deployment** → verify paths → **Save**.
4. Add models under `~/Library/Application Support/NexusAI/models/`.
5. Add company data under `company-data/`.
6. Index via **Fortinet Copilot → Grounded SOC Knowledge**.

## Metal GPU

For Apple Silicon, ensure `macos-arm64-metal` runtime is bundled. Use **Runtime → Scan** to confirm Metal acceleration.

## Uninstall

Remove `NexusAI.app` from Applications. Data remains in `~/Library/Application Support/NexusAI` until deleted.
