# PocketMind Hybrid AI Stabilization Notes

This repaired version focuses on making the core desktop app stable before adding more advanced features.

## Main fixes

- Removed duplicate frontend generation listeners from `App.tsx`.
- Changed chat generation to a stable request/response contract through `generate_response`.
- The Chat UI now replaces a single pending assistant message instead of appending streamed chunks.
- Added `update_message` so finished assistant messages persist in SQLite.
- Changed `llama-server` to use a free per-process local port instead of fixed `8082`, preventing PocketMind Hybrid AI from accidentally talking to an old leftover model server.
- Fixed missing Tailwind/PostCSS config so the production UI CSS builds correctly.
- Fixed the database migration duplicate `description` column definition.
- Kept attachment processing in place for TXT/MD/code/CSV/JSON/XML/DOCX/PPTX/XLSX/PDF basic text extraction and image metadata.

## Important model guidance

Use a normal chat/instruct GGUF for first tests:

- TinyLlama Chat
- Phi-3 Mini Instruct
- Qwen2.5 1.5B Instruct
- Mistral 7B Instruct

Do not use MedGemma as the first baseline chat model. It is not the best general assistant baseline and may need model-specific handling.

## Required external runtime

`llama-server.exe` is not included. Put it here:

```text
D:\nexus-ai\bin\llama.cpp\llama-server.exe
```

Copy all DLLs from the same llama.cpp ZIP folder too.

## Build commands

```powershell
cd D:\nexus-ai
npm install
npm run build
cd src-tauri
cargo check
cd ..
npm run tauri dev
```
