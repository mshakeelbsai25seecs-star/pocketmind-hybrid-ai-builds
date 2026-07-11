# Knowledge Chat — Next Phases (Server-Quality Roadmap)

## Completed (prior sessions)
- Extract-first structured answers (5 intent types)
- Always-on evidence fallback
- Demo vs Server deployment profiles
- Hard-pin pre-retrieval, FTS+dense RRF, intent-adaptive MMR
- Grounding check (replaced pass-2 LLM verify)
- Unified answer routing

---

## Phase A — Index-time quality
**Goal:** Better chunks and embeddings before retrieval runs.

| Task | Description | Status |
|------|-------------|--------|
| A1 | Contextual prefix prepended to `parent_text` + FTS/dense embed text | In progress |
| A2 | Paragraph-first semantic chunking for prose | In progress |
| A3 | Mirror code entities into `kc_chunks` (unified store) | In progress |
| A4 | Optional LLM contextual summaries at index time (future) | Planned |

**Success:** Rebuild index → recall@5 on QA corpus improves without reranker changes.

---

## Phase B — Neural retrieval (server profile)
**Goal:** One strong lexical + one strong semantic channel, one cross-encoder.

| Task | Description | Status |
|------|-------------|--------|
| B1 | Exact dense prefetch on server / small collections | In progress |
| B2 | Larger prefetch pool (100) on server profile | In progress |
| B3 | Qwen3-Reranker GGUF (llama.cpp RANK) as primary neural reranker; ONNX/phrase fallbacks | Done |
| B4 | ColBERT for code partition | Planned |
| B5 | Remove hash vectors from index (FTS-only lexical) | Planned |

---

## Phase C — Intent classifier
**Goal:** Robust paraphrase routing with confidence scores.

| Task | Description | Status |
|------|-------------|--------|
| C1 | Weighted pattern classifier + confidence | In progress |
| C2 | Export `intent_confidence` on search results | In progress |
| C3 | Train/export ONNX classifier from eval corpus | Planned |

---

## Phase D — Eval harness
**Goal:** Measure retrieval and answers separately; stop tuning on 5 cases.

| Task | Description | Status |
|------|-------------|--------|
| D1 | Expanded QA eval cases (paraphrase + adversarial) | In progress |
| D2 | Structured-answer eval without LLM | In progress |
| D3 | recall@5 / MRR gates in CI | Planned |
| D4 | Confidence calibration (isotonic) | Planned |

---

## Phase E — LLM role reduction
**Goal:** LLM only for open synthesis; extraction for lookups.

| Task | Description | Status |
|------|-------------|--------|
| E1 | LLM synthesis only when `detected_intent == general` | In progress |
| E2 | Optional one-sentence polish for structured answers | Planned |

---

## Deployment checklist (70B server)
1. Settings → Security → **Server** deployment profile
2. Load Qwen2.5-70B (or Llama 3.3 70B) as active model
3. Place primary Qwen3-Reranker GGUF under `models/rerankers/` (ONNX `bge-reranker-v2-m3` remains a fallback)
4. Enable HyDE + LLM query expand for vague questions
5. Rebuild collection index after Phase A changes
6. Run eval suite (`kc_run_eval`) and check recall@5 ≥ 85%
