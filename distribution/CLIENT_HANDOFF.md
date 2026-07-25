# Client handoff — what to ship

For the full product story (features, security, architecture, and positioning), give clients [`../PRODUCT_GUIDE.md`](../PRODUCT_GUIDE.md) or a PDF export of that guide. This file is only the **packaging** handoff.

**Never ship the git repository.** Do not zip the whole workspace (`.git`, `src/`, `src-tauri/`, `node_modules/`, build caches).

## Ship only

1. The staged **payload** folder from the platform stage script (`distribution/<platform>-desktop/payload/`)
2. The included docs copied into that payload (`INSTALL.md`, `WHAT_IS_INCLUDED.md`, `README.md`)
3. Optionally a short cover note pointing at `CLIENT_SHIPPING.md`

## Do not include

- `.git/` or any source tree
- `models/*.gguf` (deliver models separately, under NDA / secure channel)
- `company-data/` corpora
- Cross-platform runtimes (Windows zip must not contain `macos-*`; macOS zip must not contain `cpu`/`cuda`/`vulkan` Windows trees)

## Stage commands

| Platform | Command |
|----------|---------|
| Windows | `npm run dist:stage:windows` |
| macOS | `npm run dist:stage:macos` |
| Linux | `npm run dist:stage:linux` |

Then zip **only** the resulting `payload/` directory (plus any signed installer already inside it).

See [CLIENT_SHIPPING.md](./CLIENT_SHIPPING.md) for the full checklist.
