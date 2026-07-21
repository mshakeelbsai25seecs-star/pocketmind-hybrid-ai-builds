# Install PocketMind Hybrid AI (Windows)

## What you need

- Windows 10 or 11 (64-bit)
- 16 GB RAM or more
- Optional: NVIDIA GPU for faster inference

## Recommended: portable tester folder

The tester zip is meant to be run **from the unzipped folder**, not only from setup.exe.

1. Unzip the package (for example `C:\PocketMind\`).
2. Open the `PocketMind` folder (or the folder that contains the `.exe` and `bin\`).
3. Confirm you see:
   - `PocketMind Hybrid AI.exe` (or similar)
   - `bin\llama.cpp\` with `cpu\` (and optionally `cuda\`, `vulkan\`)
4. Double-click the `.exe`.
5. If Windows asks, choose **More info → Run anyway**.
6. Go to **Settings → Deployment**, confirm folders, then **Save**.
7. Put chat / embedding / reranker `.gguf` models in the models folder shown in Settings.
8. Knowledge Chat → add a folder → **Scan** → **Build Index** → ask in your own words.

### Data folder

On Windows the app prefers **`D:\PocketMind`** when the D: drive exists (models, indexes, cache).  
If D: is missing, it falls back to a user-writable location.  
`C:\ProgramData\PocketMind` is **not** the primary app data root.

## About setup.exe / MSI

The NSIS/MSI installers (if present) install the app binary. They **do not always include** the `bin\llama.cpp` runtimes next to the installed app.

- Prefer the **portable `.exe` + `bin\`** layout from this zip for tester builds.
- If you use setup.exe, also copy the zip’s `bin\llama.cpp` tree next to the installed executable, or keep using the portable folder.

## Optional: faster GPU

Open **Runtime**, click **Scan engine**, and keep **Automatic**.

## Uninstall

Delete the unzip / install folder. App data may remain under `D:\PocketMind` (or the path shown in Settings).

## Optional: better PDF OCR (Knowledge Chat)

Offline OCR uses Python. For layout-aware Docling OCR and OpenCV preprocess:

```
pip install pymupdf pillow pytesseract opencv-python-headless docling
```

Docling models are **not** bundled in tester zips. Without these packages, PocketMind falls back to legacy Tesseract / Windows OCR. Online Image RAG stays off unless you enable it in Settings and per collection.
