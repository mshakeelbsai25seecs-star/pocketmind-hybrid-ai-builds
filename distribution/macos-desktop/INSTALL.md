# Install PocketMind Hybrid AI (macOS)

## What you need

- macOS 12 or newer
- Apple Silicon or Intel Mac
- 16 GB RAM or more

## Steps

1. Open the `.dmg` and drag **PocketMind Hybrid AI** to Applications.
2. First launch: right-click → **Open** if macOS blocks the app.
3. Go to **Settings → Deployment**, check the folders, then **Save**.
4. Add chat models under `~/Library/Application Support/PocketMind/models/`.
5. Add company files under `company-data/` if you use Fortinet Copilot.
6. In the app, scan and index your folders before asking questions.

## Optional: Metal GPU

Open **Runtime** → **Scan engine** to confirm Metal is available.

## Uninstall

Remove the app from Applications. Data stays in `~/Library/Application Support/PocketMind` until you delete it.

## Optional: better PDF OCR (Knowledge Chat)

Install Python 3, then:

```
pip3 install pymupdf pillow pytesseract opencv-python-headless docling
```

Without these packages, OCR uses the legacy engine when available. Online Image RAG is off by default.
