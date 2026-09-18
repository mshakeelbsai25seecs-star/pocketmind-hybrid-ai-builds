# Microsoft Store — Properties page answers (English)

Use these values in Partner Center → Properties.

## Category

- **Primary category:** Productivity
- **Subcategory (if shown):** Business / Productivity tools (pick the closest Productivity subcategory available)
- **Secondary category (optional):** Developer tools  
  If Developer tools is unavailable, use **Security** as secondary because of Fortinet SOC Copilot workflows.

## Privacy policy

Prefer URL (after you publish the site page):

```text
https://noumanshakeil.github.io/privacy.html
```

Publish it with:

```powershell
cd D:\nexus-ai-deep-fixed
git fetch origin cursor/android-studio-setup-7411
git checkout origin/cursor/android-studio-setup-7411 -- distribution/github-pages
powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-SITE-ONLY.ps1
```

If Partner Center still asks for text as well, paste the full body from `distribution/github-pages/privacy.html` (or the text section below).

### Privacy policy text (paste if URL form is unavailable)

```text
Privacy Policy — PocketMind Hybrid AI (Windows)
Effective date: August 30, 2026
Publisher: nouman.shakeel555@gmail.com
Support: support.pocketmind@gmail.com

1. Overview
PocketMind Hybrid AI (“PocketMind”) is an offline-first hybrid AI desktop application. This policy explains what the app processes, what stays on your device, and what happens if you optionally connect online providers or an organization server.

2. Information processed
Depending on use, PocketMind may process:
- chat prompts, messages, attachments, and generated outputs
- local model files (for example GGUF) and runtime settings
- files/folders you explicitly open for chat, coding, image, or SOC workflows
- optional API keys and organization-server settings you enter
- hardware/diagnostics information used for local runtime selection (CPU/CUDA/Vulkan)
- backup/export archives you create
- local audit/activity logs if enabled

3. Local-first processing
By default, PocketMind runs on your Windows device. Local chat, model management, diagnostics, backups, and most workspace features are processed on-device. No account is required for core local features. App data is stored in local folders you choose or in default local data locations.

4. Optional online and organization services
If you enable cloud AI providers or an organization OpenAI-compatible server, content you send may be transmitted to those services under their own terms and privacy policies. PocketMind does not control those third-party systems. API keys you provide are stored locally in an on-device vault.

5. Generative AI
PocketMind includes generative AI features that can create text, images, code, and related content. Outputs may be inaccurate. Review generated content before relying on it, especially for security, legal, medical, or operational decisions.

6. What we do not collect by default
PocketMind does not require cloud telemetry to operate local features. We do not sell personal information. We do not use your local documents or chats to train foundation models for us unless you independently send that content to a third-party service you connect.

7. Microsoft Store and installer delivery
If you obtain PocketMind through Microsoft Store or a published package URL, Microsoft and the hosting provider may process standard download/purchase/device information under their own policies.

8. Support communications
If you email support, we process the contact details and message content you send so we can respond, and retain them only as needed to resolve the request and keep basic business records.

9. Retention and deletion
Local app data remains on your device until you delete it, uninstall the app, or clear relevant folders/backups.

10. Children
PocketMind is not directed to children under 13 (or the equivalent minimum age in your jurisdiction).

11. Security
PocketMind is designed with local control in mind, including optional encrypted key storage and local diagnostics. No method of storage or transmission is perfectly secure. Protect your device, backups, and API credentials.

12. Your choices
- use local models only and leave online providers disabled
- choose which folders/files the app may access
- enable/disable optional audit logging and backups
- disconnect organization servers and remove stored API keys
- contact us with privacy questions

13. Contact
support.pocketmind@gmail.com
nouman.shakeel555@gmail.com
Phone: +92 340 5055603
Website: https://noumanshakeil.github.io/
```

## Support info

| Field | Value |
|------|--------|
| Website | `https://noumanshakeil.github.io/` |
| Support contact info | `support.pocketmind@gmail.com` |
| Email address (Microsoft contacts you) | `nouman.shakeel555@gmail.com` |
| Phone number | `+923405055603` |
| Address | Enter your real business/home mailing address used for publisher contact. If you do not want a personal home address public, use a valid business mailing address you can receive mail at. |

## Product declarations

| Declaration | Select? | Why |
|-------------|---------|-----|
| Depends on non-Microsoft drivers or NT services | **No** for the CPU-only Store MSIX | Store MSIX does not ship CUDA/Vulkan payloads. Users may add optional GPU runtimes later from Runtime Manager (outside the Store package). |
| Tested to meet accessibility guidelines | **No** (unless you completed formal accessibility testing) | Only check if you actually tested against accessibility guidelines. |
| Supports pen and ink input | **No** | Not a core pen/ink product. |
| Incorporates generative AI features | **Yes** | Text, images, and code generation are core product capabilities. |

## Generative AI reporting (policy 11.16)

The app provides in-product **Report AI-generated content** controls (Chat, Knowledge Chat, Image Studio, Document Studio, Help, Settings → Advanced) that email `support.pocketmind@gmail.com`. Publisher must review reports and take appropriate action.

## Store listing Description

Paste from `STORE_LISTING_DESCRIPTION.md`. The first two lines must disclose **Microsoft Visual C++ Redistributable**.

## Notes for certification

Paste this:

```text
Product: PocketMind AI (MSIX) — Product ID 9NZ7WF9VXF5R

Install
- Package is an MSIX for Windows 10/11 Desktop x64.
- After install, launch “PocketMind AI” / “PocketMind Hybrid AI” from Start.

No account required for local features
- Core local chat works without sign-in.
- Online providers and organization server are optional and can remain disabled for certification.

Dependencies disclosed in Description
- Microsoft Visual C++ Redistributable (x64) is disclosed in the first two lines of the Store Description (policy 10.2.4.1).
- WebView2 Runtime is typically present on modern Windows.
- CPU local-inference runtime is included in the Store package.
- Optional CUDA/Vulkan GPU acceleration is not part of the Store MSIX payload.

Generative AI (policy 11.16)
- Product uses live generative AI for chat, images, documents, and coding assistance.
- Users can Report inappropriate AI-generated content in-app; reports go to support.pocketmind@gmail.com.

What to verify
1) App launches on Windows 10/11 x64 Desktop.
2) Home / Chat UI loads.
3) Open an assistant answer → Report (flag) opens the report dialog.
4) Help Center shows Support & report AI content.
5) Settings → Advanced → Report an issue works.
6) Local runtime / Models pages open. GGUF weights are not bundled.

Support contacts for certification questions
- support.pocketmind@gmail.com
- nouman.shakeel555@gmail.com
- +92 340 5055603
```

## System requirements

### Touch / keyboard / mouse / camera / NFC / Bluetooth / telephony / microphone

| Feature | Minimum | Recommended |
|---------|---------|-------------|
| Touch screen | Not required / leave unchecked or “Not specified” if that is the only option | Not specified |
| Keyboard | Yes / required if checkbox exists; otherwise leave as available | Yes |
| Mouse | Yes | Yes |
| Camera | Not specified | Not specified |
| NFC HCE | Not specified | Not specified |
| NFC Proximity | Not specified | Not specified |
| Bluetooth LE | Not specified | Not specified |
| Telephony | Not specified | Not specified |
| Microphone | Not specified (optional if voice features are unused in this submission) | Not specified |

If the form uses checkboxes instead of “Not specified”, check only **Keyboard** and **Mouse**. Leave the others unchecked.

### Memory / DirectX / GPU / Processor / Graphics

| Feature | Minimum hardware | Recommended hardware |
|---------|------------------|----------------------|
| Memory | 16 GB | 32 GB |
| DirectX | DirectX 12 (or leave Not specified if 12 is unavailable; do not claim a higher bar than needed) | DirectX 12 |
| Dedicated GPU memory | 0 GB / Not specified for minimum (CPU mode supported) | 8 GB |
| Processor | Quad-core CPU, x64 | 8-core CPU or better, x64 |
| Graphics | Integrated graphics acceptable for CPU mode | Discrete NVIDIA GPU (CUDA) or recent AMD/Intel GPU (Vulkan) |

If free-text boxes exist under Additional system requirements on the listing page, keep the earlier listing text:

Minimum:
```text
Windows 10 version 1903 or later (x64) or Windows 11 (x64); 4-core CPU; 16 GB RAM; 10 GB free disk for app/runtimes; extra space for GGUF models; WebView2 Runtime
```

Recommended:
```text
Windows 11 x64; 8-core+ CPU; 32 GB+ RAM; NVIDIA GPU with 8+ GB VRAM (CUDA) or recent AMD/Intel GPU (Vulkan); 50+ GB free SSD for models/indexes; current GPU drivers
```
