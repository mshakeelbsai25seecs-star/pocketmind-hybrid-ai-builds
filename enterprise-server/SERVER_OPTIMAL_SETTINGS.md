# Server Deployment — Optimal Settings Checklist

Use this when moving from the current **laptop / demo** setup to a **GPU server** for best Knowledge Chat accuracy and quality.

Today’s machine is constrained (CPU/iGPU rerank, timeouts). The server path should unlock wider retrieval, GPU RANK, larger context, and lower creativity for grounded answers.

---

## 1. Switch product / deployment profile first

| Setting | Where | Laptop / demo (now) | Server (target) |
|---------|--------|---------------------|-----------------|
| Knowledge Chat deployment profile | Settings → Security / Product (`knowledge_chat_deployment_profile`) | `demo` | **`server`** |
| Deployment mode | Deployment config (`deploy.deployment_mode` / `NEXUS_DEPLOY_MODE`) | `workstation` | **`server`** |
| Inference preset | `src/deploymentConfig.ts` | `WORKSTATION_INFERENCE_PRESET` | **`SERVER_INFERENCE_PRESET`** |

UI: set **Workstation / server — uses more context for larger models**.

After switching profile, **restart the app** and **rebuild any collection** that was indexed under different embed models or chunking.

---

## 2. Models (highest impact)

Place under the server data root (e.g. `/opt/nexusai/models` or `D:\NexusAI\models`).

### Embeddings (partitioned)

| Partition role | Best model | Path | Notes |
|----------------|------------|------|--------|
| **Code** | **Qwen3-Embedding-8B** Q4_K_M (or Q5/Q8 if VRAM allows) | `models/embeddings/Qwen3-Embedding-8B-*.gguf` | Last-token pooling; best for symbols / `ChatView.tsx`-style questions |
| **Docs / runbooks / logs / general** | **BGE-M3** Q4_K_M (or denser quant) | `models/embeddings/bge-m3-*.gguf` | Mean pooling; strong multilingual / long docs |
| Optional code alternate | Nomic Embed Text v1.5 | `models/embeddings/…` | Only if you standardize on Nomic for code |

**Do not** mix profiles inside one partition without a full re-embed. Changing the GGUF for a partition requires **rebuild index** for that collection.

HF references (also in app health UI):

- Code: https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF  
- Docs: https://huggingface.co/gpustack/bge-m3-GGUF  

### Reranker (final ranking)

| Role | Best model | Path | Notes |
|------|------------|------|--------|
| **Primary RANK** | **Qwen3-Reranker-4B** GGUF with `cls.output.weight` (llama.cpp conversion) | `models/rerankers/Qwen3-Reranker-4B-Q4_K_M.gguf` | Must use `--reranking --pooling rank` (app does this) |
| Fallback | ONNX cross-encoder | optional | Only if GGUF RANK fails |
| Remote option | Dedicated rerank service | `NEXUS_RERANK_URL=http://host:8003` | Prefer on multi-user servers |

Preferred conversion source: https://huggingface.co/Voodisss/Qwen3-Reranker-4B-GGUF-llama_cpp  

**Server GPU:** run RANK with GPU layers (full or high offload). Laptop was forced to careful GPU→CPU fallback because iGPU hung; a 16–24 GB+ NVIDIA card should keep RANK on GPU.

### Chat / answer LLM

| Tier | Recommendation | Context target |
|------|-----------------|----------------|
| Strong accuracy | 32B–70B instruct (Qwen2.5 / Llama 3.x class), Q4/Q5 or AWQ/GPTQ via vLLM/TGI | 16k–32k |
| Solid mid | 14B–32B local GGUF via llama.cpp | 8k–16k |
| Avoid for SOC QA | Tiny models (&lt;7B) as primary answerer | — |

Grounded Q&A wants **low temperature** (see §4), not creative chat defaults.

---

## 3. Retrieval / Knowledge Chat knobs

Owned in Rust: `src-tauri/src/knowledge_chat/retrieval_config.rs`  
Frontend mirror (display only): `src/knowledgeChat/retrievalConfig.ts`  
Runtime context budgets: `src/knowledgeChat/deploymentProfile.ts`

| Knob | Laptop / demo | **Server optimal** | Why |
|------|---------------|--------------------|-----|
| Search **top_k** (UI / store) | 12 | **12–16** (cap 40) | More sources without flooding the LLM |
| `retrieval_top_k` (deploy) | 8–10 | **12** | Aligns with UI default |
| `rerank_pool_limit` | 128 | **160–192** | Broader pool into dense-pair / RANK |
| `dense_prefetch_limit` | 128 | **160–200** | Better ANN recall |
| `dense_pair_rerank_top_n` | 64 | **64–96** | GPU embeds can afford it |
| `onnx_rerank_top_n` | 96 | **96** | ONNX fallback breadth |
| **`llama_rerank_top_n`** | **16** (CPU timeout safe) | **48** (GPU: try **64**) | Main quality unlock vs laptop |
| RANK snippet chars | 900 (CPU) | **1200–1400** | More signal for GlobalConstr-style joins |
| RANK HTTP batch | 8 | **8–16** | Larger batches OK on GPU |
| Dense-pair / llama / ONNX enables | all on | **all on** | RANK primary, others fallback |
| Adjacent expand + structure chunking | required | **keep + reindex** | Fixes split XML facts more than bigger top_n |

### Verify RANK is actually used

After each server question, confirm:

- UI notice: *Applied Qwen3 / llama.cpp RANK…*
- Metadata / debug: `llama_rerank_used: true`
- Not stuck on: *dense-pair/phrase fallback* or `/v1/rerank` timeout

---

## 4. Generation: context, creativity, tokens

### Knowledge Chat answer generation

From `src/knowledgeChat/prompts.ts` (`KC_GENERATION_DEFAULTS`) and deployment presets:

| Param | Laptop / demo | **Server optimal (grounded QA)** | Notes |
|-------|---------------|----------------------------------|-------|
| **temperature** | ~0.12 (KC) / deploy 0.35 | **0.08–0.15** for SOC/policy QA | Lower = less invention |
| **top_p** | 0.82 | **0.80–0.85** | Keep mild nucleus |
| **top_k** (sampling) | 40 | **40** | Fine as-is |
| **repetition_penalty** | 1.12 | **1.10–1.15** | Avoid loops on XML |
| **max_tokens** (answer) | 2k–3k demo | **3k–4k** (`deploymentProfile` server: 4096) | Long matrices / multi-part answers |
| **context_size** (llama n_ctx) | 4k–16k effective | **16k–32k** (profile server: 32768) | Must fit model + sources |
| Deploy `context_size` | 4096 workstation | **8192+** (`SERVER_INFERENCE_PRESET`) | Raise further if 70B host allows |
| Deploy `max_tokens` | 512 | **1024–2048** chat; KC may override higher | — |
| Deploy `batch_size` | 128 | **256** | Throughput |
| Deploy `gpu_layers` | -1 (auto) | **-1** or explicit high / 999 if VRAM fits | Prefer full offload for chat |
| `embed_context_size` | 2048 | **2048** (BGE/Qwen sweet spot) | Don’t inflate without testing |
| `max_snippet_chars` (deploy) | 1400 | **1600** | Server preset |

### Intent / rewrite / verify subcalls

Keep **very low creativity**:

| Call | Temperature |
|------|-------------|
| Intent classify | **0** |
| Query rewrite / expand | **0.05–0.08** |
| Citation verify | deterministic / single-token |

### Confidence gates

| Setting | Default | Server tip |
|---------|---------|------------|
| `min_source_confidence_for_context` | 0.42 | Keep **0.40–0.45** |
| `min_source_confidence_for_generation` | 0.28 | Keep **0.25–0.30**; don’t raise so high that good OCR answers get blocked |

---

## 5. Hardware & runtime layout

Minimum useful GPU server (from `enterprise-server/SERVER_REQUIREMENTS.md`):

- 16+ CPU cores, 64–128 GB RAM, NVMe  
- **24 GB+ VRAM** for Qwen3-Embedding-8B + Qwen3-Reranker-4B + mid chat model  
- **48 GB+** or multi-GPU for large chat (32B–70B) + embed + RANK concurrently  

Runtime layout:

```text
bin/llama.cpp/cuda/llama-server     # preferred on NVIDIA server
bin/llama.cpp/vulkan/llama-server   # AMD / fallback
bin/llama.cpp/cpu/llama-server      # last resort
```

Optional multi-process split on server:

| Process | Model | GPU layers |
|---------|-------|------------|
| Chat | instruct LLM | high / full |
| Embed | Qwen3-8B and/or BGE-M3 | partial / full on second GPU |
| Rerank | Qwen3-Reranker-4B | full on small GPU or CPU if chat owns VRAM |

Env overrides:

- `NEXUS_LLAMA_SERVER` — pin binary  
- `NEXUS_RERANK_URL` — remote RANK service  
- `NEXUS_DEPLOY_MODE=server` — server deploy defaults  

Enterprise full-RAG stack (Docker gateway + remote embed/rerank): see `enterprise-server/full-rag/`.

---

## 6. Indexing / corpus (do not skip)

| Step | Server action |
|------|----------------|
| Chunking | Rebuild after structure-preserving XML/markdown chunking |
| Adjacent expand | Leave enabled (sibling chunks for split facts) |
| Dedup | Fingerprint dedup on; avoid indexing both `01_sanitized_*` and `11_import_ready` duplicates if possible |
| OCR | Ensure PDF OCR path works; prefer searchable markdown sidecars for policies |
| Contextual indexing | `enable_contextual_indexing: true` on server |
| LLM contextual summaries | Optional (`enable_llm_contextual_summaries`); on only if you accept slower index + extra GPU |

---

## 7. Code / config touch list (when promoting to server)

Checklist of what to change in-repo or in settings:

### A. Settings / UI (no code required)

1. `knowledge_chat_deployment_profile` → **`server`**  
2. Deployment mode → **`server`**  
3. Apply **SERVER_INFERENCE_PRESET** (context 8192+, max tokens 1024+, batch 256, retrieval top_k 12, snippets 1600)  
4. Temperature for KC answers → **≤ 0.15**  
5. Confirm embed + rerank paths under `models/`  
6. Full **rebuild** of production collections  

### B. Code defaults (already or should be server-specific)

| File | Change for server |
|------|-------------------|
| `retrieval_config.rs` → `RetrievalConfig::server()` | Higher `llama_rerank_top_n` (48+), optional wider pools |
| `llama_rerank.rs` | On server GPU path: longer snippets (1200–1400); keep batched POST |
| `deploymentProfile.ts` | Already: context 32k budget, maxSources 64, maxTokens 4096 |
| `deploymentConfig.ts` | Already: `SERVER_INFERENCE_PRESET` |
| `retrievalConfig.ts` (TS mirror) | Keep in sync with Rust when changing defaults |

### C. Ops

1. NVIDIA drivers + CUDA llama.cpp runtime verified  
2. Smoke: one KC question → `llama_rerank_used: true` in &lt;30s warm  
3. Health panel: partitions dense-ready, RANK configured  
4. Load-test concurrent users if sharing one RANK server  

---

## 8. Side-by-side summary

| Area | Current laptop-safe | Server best quality |
|------|---------------------|---------------------|
| Profile | `demo` | **`server`** |
| Code embed | Qwen3-Embedding-8B (if fits) | **Qwen3-Embedding-8B** (GPU) |
| Doc embed | BGE-M3 | **BGE-M3** (GPU) |
| Reranker | Qwen3-Reranker-4B (CPU, top 16) | **Same GGUF on GPU, top 48–64** |
| top_k | 12 | **12–16** |
| Context (KC) | ~16k budget | **~32k budget** |
| max answer tokens | ~3k | **~4k** |
| Temperature | low | **keep low (0.08–0.15)** |
| Creativity | low | **stay low** for grounded SOC QA |
| Chat model | whatever fits laptop | **largest accurate instruct that fits VRAM** |

---

## 9. Acceptance tests after cutover

Ask the same three accuracy questions:

1. Brute Force Host Login Success — window, `COUNT(*)≥5`, three join fields (`GlobalConstr`)  
2. Escalation matrix levels + response times  
3. Linux Audit parser coverage + key fields  

Expect:

- Correct file in top sources  
- `llama_rerank_used: true`  
- All three facts for (1) present in context (adjacent expand + RANK)  
- No `/v1/rerank` timeout; no multi-minute `llama_rank_ms` hangs  

---

## 10. Related docs

- `enterprise-server/SERVER_REQUIREMENTS.md` — hardware  
- `enterprise-server/full-rag/README.md` — Docker RAG gateway  
- `ENTERPRISE_SERVER_MODE.md` — enterprise mode overview  
- Collection Health panel in-app — live model / partition status  

---

*Last updated for the laptop→server promotion after Qwen RANK spawn/scoring fixes (GPU→CPU fallback, batched `/v1/rerank`, `llama_rerank_top_n` split from ONNX).*
