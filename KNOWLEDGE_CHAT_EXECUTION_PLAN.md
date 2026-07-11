# Knowledge Chat — RAG Upgrade Execution Plan

**Status (2026-06-19):** Phases A–E implemented including warm embed pool (C2). Backend compiles; frontend builds. After upgrading, run **Rebuild** once to populate FTS5.

Independent module only (`src/knowledgeChat/*`, `src-tauri/src/knowledge_chat/*`). No SOC coupling.

## Phase A — Intake & Index Quality

| Step | Module | Deliverable |
|------|--------|-------------|
| A1 | `filter.rs` | Block noisy files (`.min.js`, `.map`, binaries, lockfiles), min text length sniff |
| A2 | `scanner.rs` | Wire filter + priority tiers from path heuristics |
| A3 | `db.rs` | Incremental scan upsert (preserve indexed unchanged files) |
| A4 | `chunking.rs` | Structure-aware splits (headings/paragraphs) + parent–child context |
| A5 | `indexer.rs` | Content fingerprint dedup, skip unchanged, parallel extraction |

## Phase B — Retrieval Quality

| Step | Module | Deliverable |
|------|--------|-------------|
| B1 | `fts.rs` + migration | SQLite FTS5 index synced on chunk write |
| B2 | `search.rs` | BM25/FTS signal in RRF, candidate pooling for dense |
| B3 | `query.rs` | Multi-part query decomposition + merged results |
| B4 | `rerank.rs` | Secondary rerank pass (phrase/title/section boosts) |
| B5 | `search.rs` | Retrieval confidence (`high`/`medium`/`low`/`none`) |

## Phase C — Speed & Efficiency

| Step | Module | Deliverable |
|------|--------|-------------|
| C1 | `indexer.rs` | Rayon parallel file extraction (DB writes sequential) |
| C2 | `runtime.rs` | Warm embedding server pool (`KcEmbedPool` in `AppState`) |
| C3 | `search.rs` | Dense scoring only on FTS∪lexical candidate union |

## Phase D — Answer Reliability

| Step | Module | Deliverable |
|------|--------|-------------|
| D1 | `prompts.ts` | Two-pass grounded answering + answer mode headers |
| D2 | `KnowledgeChatPanel.tsx` | Confidence gate blocks weak answers |
| D3 | `prompts.ts` | Inject `parent_text` / expanded context in snippets |

## Phase E — Evaluation & Ops

| Step | Module | Deliverable |
|------|--------|-------------|
| E1 | `eval.rs` | Golden Q&A harness command `kc_run_eval` |
| E2 | `EvalPanel.tsx` | UI to run eval against active collection |
| E3 | `KNOWLEDGE_CHAT.md` | Updated architecture docs |

## Schema v2 (kc_*)

New columns:
- `kc_files.text_fingerprint`, `priority_tier`
- `kc_chunks.parent_text`, `section_path`, `doc_type`, `text_fingerprint`

New virtual table: `kc_chunks_fts`

## Success Criteria

- Incremental re-index skips unchanged files
- FTS improves exact-term recall (IDs, hostnames, codes)
- Hybrid search returns confidence metadata
- Chat refuses to guess when confidence is `none`/`low`
- Eval command reports recall@k on bundled golden set
- `cargo check` + `npm run build` pass
