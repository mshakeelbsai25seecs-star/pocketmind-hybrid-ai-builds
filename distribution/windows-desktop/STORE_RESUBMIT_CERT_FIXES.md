# Store resubmit — certification fixes (10.2.4.1 + 11.16 + 10.1.2.7)

Product: **PocketMind AI**  
Product ID: **9NZ7WF9VXF5R**  
Package identity: `PocketMind.PocketMindAI`  
Target package version: **1.0.2.0** (or next unused version after your last failed package)

## Failures from certification report

1. **10.2.4.1 Security - Software Dependencies** — undisclosed Microsoft Visual C++
2. **11.16 Live Generative AI Content** — missing in-app report path for AI output
3. **10.1.2.7 Functionality** — privacy URL did not resolve (`https://noumanshakeil.github.io/privacy.html`)

## Publisher actions in Partner Center

### A) Description (fixes 10.2.4.1)

Open **Store listing → Description** and paste the text from:

`distribution/windows-desktop/STORE_LISTING_DESCRIPTION.md`

The **first two lines must remain**:

```text
Requires Microsoft Visual C++ Redistributable (x64). Install from Microsoft if Windows prompts for missing VC++ runtime DLLs.
This Store package includes PocketMind AI and a CPU local-inference runtime. ...
```

Do not bury the Visual C++ line below other marketing copy.

### B) Privacy URL (fixes 10.1.2.7)

You own this step. Ensure the Properties privacy policy URL opens a real page globally before resubmit. Keep Properties → Privacy policy pointing at a working URL (or paste full privacy text if Partner Center requires it). See `STORE_PROPERTIES.md`.

### C) Package (ships 11.16 Report feature)

1. Build/stage the Store MSIX from this branch (CPU-only layout; no CUDA/Vulkan payload).
2. Pack version **1.0.2.0** (manifest already bumped in repo).
3. Upload **only** the new MSIX under Packages.
4. Remove older failed packages from the submission.
5. Device family: **Windows 10/11 Desktop** only.
6. Keep `runFullTrust` justification.
7. Confirm Product declarations still mark **Incorporates generative AI features = Yes**.
8. Submit.

Do **not** Authenticode-sign the Store MSIX — Microsoft re-signs it.

## In-app Report feature (policy 11.16)

Users can report inappropriate AI-generated content from:

- Chat — flag icon on assistant messages
- Knowledge Chat — Report on answers
- Image Studio — Report on gallery / preview
- Document Studio — Report AI content on outline preview
- Help Center — Support & report section + mailto
- Settings → Advanced — Report an issue

Reports open email to `support.pocketmind@gmail.com` with reason + excerpt (clipboard fallback if mailto fails).

## Notes for certification (optional paste)

```text
Product: PocketMind AI (MSIX) — Product ID 9NZ7WF9VXF5R

10.2.4.1
- Store Description line 1 discloses Microsoft Visual C++ Redistributable (x64).

11.16
- App includes Report AI-generated content controls on Chat, Knowledge Chat, Image Studio, Document Studio, Help, and Settings → Advanced.
- Reports are emailed to support.pocketmind@gmail.com for publisher review and action.

10.1.2.7
- Privacy policy URL updated/verified by publisher before this submission.

Package
- CPU Store MSIX only; optional GPU runtimes are not in the Store package payload.
- No account required for local features.
```

## Do not

- Do not upload an old package that lacks the Report UI
- Do not put Visual C++ disclosure only in Notes / System requirements — it must be in the Description’s first two lines
- Do not reintroduce CUDA/Vulkan into the Store MSIX payload
