# Store resubmit — certification + store-parity (1.0.3.0)

Product: **PocketMind AI**  
Product ID: **9NZ7WF9VXF5R**  
Package identity: `PocketMind.PocketMindAI`  
Target package version: **1.0.3.0**

Full Partner Center upload steps: `PARTNER_CENTER_MSIX_UPLOAD.md`

## Failures from prior certification (still apply)

1. **10.2.4.1 Security - Software Dependencies** — undisclosed Microsoft Visual C++
2. **11.16 Live Generative AI Content** — missing in-app report path for AI output
3. **10.1.2.7 Functionality** — privacy URL did not resolve (`https://noumanshakeil.github.io/privacy.html`)

## Publisher actions in Partner Center

### A) Description (fixes 10.2.4.1)

Open **Store listing → Description** and paste the text from:

`distribution/windows-desktop/STORE_LISTING_DESCRIPTION.md`

The **first two lines must remain** the Visual C++ + CPU package disclosure.

### B) Privacy URL (fixes 10.1.2.7)

Ensure Properties privacy policy URL opens a real page globally before resubmit. See `STORE_PROPERTIES.md`.

### C) Package (ships 11.16 Report + store-parity)

1. Build/stage the Store MSIX from this branch (CPU-only layout; no CUDA/Vulkan payload).
2. Pack version **1.0.3.0**.
3. Upload **only** the new MSIX under Packages (file upload for MSIX product type).
4. Remove older failed packages from the submission.
5. Device family: **Windows 10/11 Desktop** only.
6. Keep `runFullTrust` justification.
7. Confirm Product declarations still mark **Incorporates generative AI features = Yes**.
8. Submit.

Do **not** Authenticode-sign the Store MSIX — Microsoft re-signs it.

## In-app Report feature (policy 11.16)

Users can report inappropriate AI-generated content from:

- Chat — flag icon on assistant messages
- Image Studio — Report on gallery / preview
- Document Studio — Report AI content on outline preview
- Help Center — Support & report section + mailto
- Settings → Advanced — Report an issue

(Reports may also remain available on Knowledge Chat panel code paths used by SOC retrieval; Knowledge Chat is not a primary Store nav surface on this branch.)

Reports open email to `support.pocketmind@gmail.com` with reason + excerpt (clipboard fallback if mailto fails).

## Notes for certification (optional paste)

```text
Product: PocketMind AI (MSIX) — Product ID 9NZ7WF9VXF5R — package 1.0.3.0

10.2.4.1
- Store Description line 1 discloses Microsoft Visual C++ Redistributable (x64).

11.16
- App includes Report AI-generated content controls on Chat, Image Studio, Document Studio, Help, and Settings → Advanced.
- Reports are emailed to support.pocketmind@gmail.com for publisher review and action.

10.1.2.7
- Privacy policy URL updated/verified by publisher before this submission.

Package
- CPU Store MSIX only; optional GPU runtimes are not in the Store package payload.
- No account required for local features.
- Store-parity surfaces: PocketCode, Model Manager, SOC Copilot, Control Center, Characters, Hardware & Runtime, Image Studio.
```

## Do not

- Do not upload an old package that lacks the Report UI or store-parity surfaces
- Do not put Visual C++ disclosure only in Notes / System requirements — it must be in the Description’s first two lines
- Do not reintroduce CUDA/Vulkan into the Store MSIX payload
- Do not claim Windows cmd/PowerShell PTY was live-tested on Linux CI agents
