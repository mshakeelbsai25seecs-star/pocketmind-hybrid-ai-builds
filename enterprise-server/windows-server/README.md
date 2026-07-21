# Windows Server Notes

For **Full Server RAG** (embeddings + rerank + Knowledge Chat gateway), use Linux or **WSL2 Ubuntu**:

→ [../full-rag/docs/WSL2_WINDOWS_SERVER.md](../full-rag/docs/WSL2_WINDOWS_SERVER.md)

Native Windows is not a supported host for the `full-rag` Docker package.

## Chat-only alternatives (not full-rag)

If you only need an OpenAI-compatible chat endpoint (no server-side Knowledge Chat indexing):

### Option A: WSL2 Ubuntu + vLLM

Use when IT allows WSL2 and NVIDIA GPU passthrough is working.

### Option B: Native Ollama

Use for simpler pilots and medium models.

### Option C: Windows acts only as a client host

Keep the model / RAG server on a Linux GPU machine and use Windows laptops as PocketMind Hybrid AI clients.
