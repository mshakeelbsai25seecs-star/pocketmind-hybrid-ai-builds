# PocketMind AI — App Knowledge Document

Last updated: 2026-09-19  
Repo: `https://github.com/noumanshakeil/nexus-ai-deep-fixed`  
Typical Windows clone: `D:\nexus-ai-deep-fixed`

This is the single reference for product identity, features, Store status, packaging, and **where every image lives**.

---

## 1. What the app is

**PocketMind Hybrid AI** (Store listing name: **PocketMind AI**) is a local-first hybrid AI desktop app for Windows (primary), with macOS/Linux support and an Android companion.

Users can:

- Chat with **local GGUF models** (llama.cpp) offline
- Optionally use **cloud providers** (OpenAI, Anthropic, Gemini, Groq, etc.)
- Connect an **organization OpenAI-compatible server**
- Use **Knowledge Chat** (folder RAG), **PocketCode** (coding agent), **Image Studio**, **Document Studio**, and **Fortinet SOC Copilot**

Core promise: local data stays on device unless the user opts into online/org backends.

---

## 2. Product identity

| Field | Value |
|-------|--------|
| Display name (desktop / EXE) | PocketMind Hybrid AI |
| Store listing name | PocketMind AI |
| npm / Cargo name | `nexus-ai` `1.0.0` |
| Tauri bundle ID | `com.nexusai.app` |
| MSIX Identity Name | `PocketMind.PocketMindAI` |
| Publisher display | PocketMind |
| Publisher CN | `CN=78BD2D1C-2460-451B-91FD-410288D37531` |
| Package Family Name (PFN) | `PocketMind.PocketMindAI_fawhaqqkcp3dj` |
| **Store product ID (MSIX)** | `9NZ7WF9VXF5R` |
| Legacy EXE/URL product UUID | `c2aea639-62fc-4bda-b565-4f1ae4f70e9a` |
| MSIX Application Id | `PocketMindHybridAI` |
| Executable | `PocketMind Hybrid AI.exe` |
| Current MSIX Identity Version | **1.0.2.0** |
| Android package | `com.pocketmind.hybridai` (`versionName` 1.0.2 / `versionCode` 3) |

### Contacts

| Role | Value |
|------|--------|
| Support | `support.pocketmind@gmail.com` |
| Publisher | `nouman.shakeel555@gmail.com` |
| Phone | `+92 340 5055603` |
| Public site | `https://noumanshakeil.github.io/` |
| Privacy policy URL | `https://noumanshakeil.github.io/privacy.html` |

### Relevant branches

| Branch | Role |
|--------|------|
| `main` | Default |
| `cursor/android-studio-setup-7411` | Store tooling / prior Store work base |
| `cursor/store-cert-11-16-report-7411` | VC++ disclosure docs + in-app Report AI (policy 11.16) + MSIX 1.0.2.0 |

---

## 3. Features (sidebar / views)

| UI label | View id | What it does |
|----------|---------|--------------|
| Home | `home` | Dashboard |
| Chats | `chat` | Local / online / org chat |
| Fortinet Copilot | `soc` | SOC drafts, validators, reports |
| Knowledge Chat | `knowledge-chat` | Grounded Q&A over folders |
| PocketCode | `code-workspace` | Coding agent, sandbox, MCP, plans |
| Models | `models` | GGUF library + online catalog / keys |
| Org Server | `enterprise-server` | Company OpenAI-compatible endpoint |
| Image Studio | `image-studio` | AI image generation |
| Document Studio | `document-studio` | Offline DOCX / PPTX / PDF |
| System | `hardware` | CPU / RAM / GPU info |
| Runtime | `runtime` | llama.cpp scan / optimizer |
| Diagnostics | `diagnostics` | Health checks |
| Prompts / Characters | `prompts` / `characters` | Prompt library / personas |
| Storage / Backup | `storage` / `backup` | Cleanup, export, encrypted backup |
| Help / Settings | `help` / `settings` | Guide, Report AI, providers, MCP, security |
| Setup (first run) | `setup` | Onboarding wizard |

### AI backends

- **Local:** GGUF + bundled `llama-server` (no account required)
- **Online (optional):** provider API keys stored in local vault
- **Org server (optional):** OpenAI-compatible base URL + bearer
- Product rule: **no silent failover** between backends

### Runtimes

| Package type | What’s included |
|--------------|-----------------|
| Fat / full desktop installer | CPU + optional CUDA + Vulkan under `llama.cpp` |
| **Microsoft Store MSIX / Store-safe build** | **CPU only** (GPU can be added later via Runtime Manager) |

### Bundled tooling (desktop resources)

- ripgrep, embedded Python 3.12.9, Node (versions tracked in tooling manifest)
- OCR / document export workers under Tauri resources

---

## 4. Tech stack

| Layer | Stack |
|-------|--------|
| Shell | Tauri 1.5 |
| Frontend | React 18, Vite 5, TypeScript, Tailwind, Zustand |
| Backend | Rust (SQLite, local inference orchestration, optional embeddings/rerank) |
| Mobile | Android companion under `android/` |

### Important folders

```text
src/                 React UI
src-tauri/           Rust + icons + bundled resources
distribution/        Installers, MSIX, Store docs, listing art, GitHub Pages
scripts/             Build / runtime / Store / icon scripts
android/             Play companion
docs/                Extra docs (including this file)
PRODUCT_GUIDE.md     Full feature encyclopedia
```

---

## 5. Microsoft Store status

### Certification history

| Policy | Issue | Fix |
|--------|-------|-----|
| **10.2.4.2** | CUDA/Vulkan treated as non-Microsoft deps | Ship **CPU-only** Store package |
| **10.2.9** | Unsigned EXE/URL | Authenticode-sign EXE **or** use **MSIX** (MS re-signs) |
| **10.1.1.11** | Blurry Start tiles | Sharp tiles in `msix/Assets/` |
| **10.2.4.1** | Undisclosed Visual C++ | Disclose VC++ in **first two lines** of Store Description |
| **11.16** | No way to report AI output | In-app **Report AI content** → `support.pocketmind@gmail.com` |
| **10.1.2.7** | Privacy URL broken | Publisher must host a working privacy page |

### Current resubmit target

- Package: `PocketMind.PocketMindAI_1.0.2.0_x64.msix`
- Device family: Windows 10/11 **Desktop only**
- Do **not** Authenticode-sign Store MSIX
- Description paste: `distribution/windows-desktop/STORE_LISTING_DESCRIPTION.md`
- Full checklist: `distribution/windows-desktop/STORE_RESUBMIT_CERT_FIXES.md`

### Where the MSIX is created (on your PC)

After packing on Windows:

```text
D:\nexus-ai-deep-fixed\distribution\windows-desktop\msix\out\PocketMind.PocketMindAI_1.0.2.0_x64.msix
```

Scripts:

- Stage: `distribution/windows-desktop/msix/stage-msix-layout.ps1`
- Pack: `distribution/windows-desktop/msix/PACK-MSIX.ps1`
- Manifest: `distribution/windows-desktop/msix/Package.appxmanifest`

If packing still outputs `…_1.0.0.0_x64.msix`, the local clone is on an old script/branch — force bump layout `AppxManifest.xml` to `1.0.2.0` and pack with an explicit output filename.

### In-app Report AI (policy 11.16)

Available in:

- Chat (flag on assistant messages)
- Knowledge Chat
- Image Studio
- Document Studio
- Help Center
- Settings → Advanced

---

## 6. Where all the images are

### Quick map

| Purpose | Folder |
|---------|--------|
| **Canonical Store / MSIX tiles + splash** | `distribution/windows-desktop/msix/Assets/` |
| **Partner Center listing screenshots + box/poster art** | `distribution/microsoft-store-assets/` |
| **Desktop app icon set (Tauri / Windows / macOS)** | `src-tauri/icons/` |
| **In-app logo sources** | `src/assets/` |
| **Public/web mark** | `public/pocketmind-logo-mark.png` |
| Privacy / site pages | `distribution/github-pages/` (HTML; not product PNGs) |

---

### A. MSIX / Start menu tiles (USE THESE FOR STORE PACKAGE)

Path: `distribution/windows-desktop/msix/Assets/`

| File | Role |
|------|------|
| `StoreLogo.png` (+ `.scale-200`, `.scale-400`) | Package / Store logo |
| `Square44x44Logo.png` (+ scales) | Small Start tile |
| `Square71x71Logo.png` (+ scale-200) | Medium-small tile |
| `Square150x150Logo.png` (+ `.scale-200`, `.scale-400`) | Medium Start tile |
| `Square310x310Logo.png` (+ scales) | Large Start tile |
| `Wide310x150Logo.png` (+ scale-200) | Wide tile |
| `SplashScreen.png` (+ scale-200) | Splash |

Master source used to regenerate these: `src-tauri/icons/app-icon-master.png`  
Generator: `distribution/windows-desktop/msix/GENERATE-MSIX-TILE-ASSETS.ps1`

**Rule:** Always stage Store tiles from `msix/Assets/`. Do not ship the tiny placeholder logos from `src-tauri/icons/`.

---

### B. Microsoft Store listing art (Partner Center upload)

Path: `distribution/microsoft-store-assets/`

**Logos** — `logos/`

| File | Use |
|------|-----|
| `pocketmind-box-art-1080.png` | 1:1 box art (1080×1080) |
| `pocketmind-poster-art-1440x2160.png` | 9:16 poster |
| `pocketmind-poster-art-720x1080.png` | 9:16 poster (smaller) |

**Screenshots** — `screenshots/` (≈1536×1024)

| File | Shows |
|------|--------|
| `01-private-chat.png` | Chat |
| `02-image-studio.png` | Image Studio |
| `03-fortinet-soc-copilot.png` | Fortinet SOC Copilot |
| `04-pocketcode.png` | PocketCode |
| `05-characters.png` | Characters |
| `06-hardware-runtime.png` | Hardware / Runtime |
| `07-hybrid-models.png` | Hybrid models |
| `08-control-center.png` | Control center / settings-style overview |

Captions / sizes: `distribution/microsoft-store-assets/README.md`

---

### C. Desktop OS icons (Tauri)

Path: `src-tauri/icons/`

| File | Use |
|------|-----|
| `app-icon-master.png` | Master 512 source for regenerating icons/tiles |
| `icon.png`, `icon.ico`, `icon.icns` | App icons (Windows / macOS) |
| `32x32.png`, `128x128.png`, `128x128@2x.png` | Tauri icon set |
| `StoreLogo.png`, `Square*Logo.png`, `Wide310x150Logo.png`, `SplashScreen.png` | Copies of sharp tiles (also present under msix/Assets) |
| `Square30x30Logo.png`, `Square89x89Logo.png`, `Square107x107Logo.png` | **Tiny placeholders — do not use for Store** |
| `Square142x142Logo.png`, `Square284x284Logo.png` | Legacy intermediate sizes — prefer `msix/Assets` |

Generator: `scripts/generate_app_icons.py`

---

### D. In-app branding

Path: `src/assets/`

| File | Use |
|------|-----|
| `pocketmind-logo.png` | Primary logo |
| `pocketmind-logo-sharp.png` | Sharper variant |
| `pocketmind-logo-transparent-v3.png` | Transparent variant |
| `pocketmind-logo-mark.png` | Compact mark |

Also copied for static serving:

- `public/pocketmind-logo-mark.png`

---

### E. What is *not* image product art

- Lucide icons in React are vector components, not image files
- Generated AI images from Image Studio are runtime user content, not repo assets
- Android launcher icons live under `android/app/src/.../res/` (mipmap / drawable) if present in that tree

---

## 7. Key docs already in the repo

### Store / Windows

- `distribution/windows-desktop/STORE_LISTING_DESCRIPTION.md` — Description with VC++ first lines
- `distribution/windows-desktop/STORE_PROPERTIES.md` — Partner Center Properties answers
- `distribution/windows-desktop/STORE_RESUBMIT_CERT_FIXES.md` — Current cert resubmit checklist
- `distribution/windows-desktop/STORE_RESUBMIT_10_2_4_2.md` — CPU-only Store fix
- `distribution/windows-desktop/STORE_RESUBMIT_10_2_9.md` — Signing / MSIX path
- `distribution/windows-desktop/msix/README.md` — MSIX identity + pack steps
- `distribution/microsoft-store-assets/README.md` — Listing screenshots / logos

### Product / ops

- `PRODUCT_GUIDE.md` — Feature encyclopedia
- `README.md` — Dev / build entry
- `KNOWLEDGE_CHAT.md`, `ENTERPRISE_SERVER_MODE.md`, `FORTINET_SOC_DEMO_GUIDE.md`
- `distribution/github-pages/privacy.html` — Privacy page source
- `android/README.md`, `android/PLAY_RELEASE_CHECKLIST.md`

---

## 8. Publisher next steps (Store)

1. Be on branch `cursor/store-cert-11-16-report-7411` (or merge it).
2. Rebuild/stage the Store layout and pack **1.0.2.0** MSIX.
3. Upload only:
   `distribution\windows-desktop\msix\out\PocketMind.PocketMindAI_1.0.2.0_x64.msix`
4. Paste Description from `STORE_LISTING_DESCRIPTION.md` (VC++ lines must stay first).
5. Fix privacy URL so it resolves globally.
6. Confirm generative AI declaration = Yes; keep Report feature in the built app.
7. Resubmit.

---

## 9. One-line summary

**PocketMind AI** (`9NZ7WF9VXF5R`, PFN `PocketMind.PocketMindAI_fawhaqqkcp3dj`) is a Tauri + React local-first hybrid AI desktop app shipping a CPU-only Store MSIX (`1.0.2.0`) with optional post-install GPU runtimes and cloud/org backends; Store tiles live in `distribution/windows-desktop/msix/Assets/`, listing art in `distribution/microsoft-store-assets/`, and app icons in `src-tauri/icons/` + `src/assets/`.
