# Install PocketMind Hybrid AI (Linux)

## What you need

- Ubuntu 22.04+ (or similar)
- 16 GB RAM or more

## AppImage

```bash
chmod +x "PocketMind Hybrid AI_"*.AppImage
./"PocketMind Hybrid AI_"*.AppImage
```

## Debian package

```bash
sudo dpkg -i nexus-ai_*.deb
sudo apt-get install -f
nexus-ai
```

## First run

1. Open **Settings → Deployment**, check folders, then **Save**.
2. Add chat models and (optional) company data.
3. Scan and index folders in the app before asking questions.

Data usually lives in `~/.local/share/PocketMind`.

## Optional: better PDF OCR (Knowledge Chat)

`ash
pip3 install pymupdf pillow pytesseract opencv-python-headless docling
`

Docling models are not bundled by default. Online Image RAG remains off unless enabled globally and per collection.

Optional Unlimited-OCR (NVIDIA CUDA + `torch`/`transformers`/`pymupdf`): download weights from **Settings → Security → Scanned PDFs**. Optional Document Studio exporters: `pip3 install python-docx python-pptx reportlab`.
