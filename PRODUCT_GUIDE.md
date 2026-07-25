# PocketMind Hybrid AI — Complete Product Guide

**Product:** PocketMind Hybrid AI (`com.nexusai.app`)  
**Package / version:** `nexus-ai` **1.0.0**  
**Stack:** Tauri 1 · Rust backend · React 18 / Vite / TypeScript / Zustand  
**Primary ship target:** Windows desktop portable package  
**Also supported:** macOS (Apple Silicon + Intel), Linux desktop, optional Android companion, optional enterprise server stack  

This document is the canonical guide for clients, operators, developers, and investors. Specialized runbooks remain available (`RELEASE_CHECKLIST.md`, `KNOWLEDGE_CHAT.md`, `ENTERPRISE_SERVER_MODE.md`, `FORTINET_SOC_DEMO_GUIDE.md`, `distribution/`); they deepen topics already introduced here.

---

## 1. Executive summary

PocketMind Hybrid AI is an **offline-first hybrid AI workspace** that runs on the user’s machine. It combines:

1. **Local large-language-model chat** via llama.cpp (`llama-server`) and GGUF models  
2. **Grounded Knowledge Chat (RAG)** over any folder the user selects  
3. **Fortinet SOC Copilot** workflows for incident triage, drafts, validators, and reports  
4. **PocketCode** — a coding agent with filesystem tools, sandbox options, MCP integrations, and native tool calling for major cloud providers  
5. **Optional cloud / organization backends** — online providers (OpenAI, Groq, Anthropic, Gemini, and other OpenAI-compatible APIs) plus a company OpenAI-compatible server  

The product is designed for environments where **privacy, air-gap readiness, auditability, and evidence-grounded answers** matter as much as raw model quality. Users are not forced into a single cloud vendor. Local inference remains first-class; cloud and enterprise servers are opt-in accelerators.

---

## 2. The problem we solve

Organizations and power users face a fractured landscape:

- Consumer chat apps send proprietary data to third-party clouds by default.  
- Pure local LLM apps often lack serious retrieval, SOC workflows, or agent tooling.  
- Enterprise “copilots” are frequently SaaS-only, hard to air-gap, and weak at citing **your** documents.  
- Coding agents either require constant cloud connectivity or ship without MCP/native tool protocols that modern models expect.  
- Security operations teams need drafts grounded in **company Fortinet/runbook corpora**, with human approval before anything touches production.

PocketMind Hybrid AI addresses this by putting a **complete AI workspace on the desktop**, with clear modes for local, online, and organization-server inference, and with retrieval and agent actions that stay under user control.

---

## 3. Who our clients are

| Segment | Why PocketMind fits |
|---------|---------------------|
| **SOC / Fortinet analysts** | Incident forms, practice scenarios, grounded drafts, validators, Markdown reports — without live SIEM writes |
| **MSPs and security consultancies** | Portable Windows packages for client sites; company-data folders per engagement |
| **Regulated / privacy-sensitive enterprises** | Local-first processing; vaulted API keys; audit log; optional air-gapped enterprise server |
| **Internal platform / IT teams** | Deployment roots, runtime manager (CPU/CUDA/Vulkan/Metal), diagnostics, backup/restore |
| **Engineering teams** | PocketCode agent, MCP bridge to Cursor, Knowledge Chat over repos, sandbox runners |
| **AI power users** | Hybrid local + multi-provider online catalog, characters, prompts, Image Studio |

If a buyer needs “ChatGPT but locked to our documents and our network,” PocketMind is the product conversation. If they need “a coding agent that can stay on-prem,” PocketCode is the wedge. If they need “SOC drafts that cite our runbooks,” Fortinet Copilot is the wedge.

---

## 4. Competitive edge — why choose PocketMind

1. **Hybrid by design, not as an afterthought.** Local GGUF, online providers, and organization servers share one UI and one conversation model. No silent model failover: if a backend fails, the user sees a clear error.  
2. **Evidence-first Knowledge Chat.** Hybrid lexical (FTS) + dense retrieval, reranking (Qwen3 RANK GGUF primary with ONNX/phrase fallbacks), confidence gating, extractive/structured answers when evidence is strong, and LLM synthesis only when needed.  
3. **Vertical SOC value.** Fortinet-oriented workflows, company knowledge intake, validators that catch placeholder junk, and explicit human-approval disclaimers.  
4. **Serious agent stack.** PocketCode tools, permission overlays, MCP host (stdio JSON-RPC), Cursor project bridge, dual tool protocols: **native** (OpenAI-compat, Anthropic, Gemini) and **JSON** for local/unsupported models.  
5. **Portable runtimes.** Windows ships CPU / CUDA / Vulkan trees; macOS ships arch-specific Metal/CPU; Automatic Optimizer and CPU Safe profiles reduce “it doesn’t run on my GPU” support load.  
6. **Operator-grade packaging.** `distribution/` stages client payloads without shipping source trees, customer corpora, or GGUF weights by accident.  
7. **No cloud lock-in.** Keys live in a device-derived vault; data roots are user-chosen (`NEXUS_DATA_ROOT` / Settings → Deployment). New Windows installs default to `%LOCALAPPDATA%\PocketMind` while still detecting existing developer/legacy trees.

### What we did differently

- **Extract-first RAG** with evidence fallbacks so weak retrieval does not hallucinate confidently.  
- **Demo vs Server deployment profiles** for Knowledge Chat so laptops and 70B servers are not forced into the same context budgets.  
- **Dual tool protocols** so PocketCode works on frontier APIs *and* local GGUF agents.  
- **Cursor MCP bridge** so teams can reuse the same filesystem MCP server inside PocketMind and Cursor.  
- **Human-in-the-loop tools** — agent tool calls require confirmation; SOC artifacts are drafts for analyst review.  
- **Folder-agnostic knowledge mode** — any folder can become a collection; codebase explorer mode adds symbol-first retrieval for repos.

---

## 5. Feature encyclopedia (application views)

Navigation is driven by `AppView` in the React shell (`src/App.tsx`, `Sidebar.tsx`, `Layout.tsx`).

| View | Purpose |
|------|---------|
| **Home** | Dashboard entry and orientation |
| **Setup** | First-run wizard: paths, models, sanity checks |
| **Chat** | Multi-conversation local/online/org chat; attachments; context budget; stop generation; characters |
| **Fortinet Copilot (SOC)** | Incident input, practice scenarios, knowledge collection, validators, reports, data-pack intake |
| **Knowledge Chat** | Collections, index/scan, grounded Q&A, sources, health, eval panel |
| **PocketCode** | Workspace root, agent modes, plan review, sandbox, permission overlay, MCP tools |
| **Hardware** | RAM / GPU / VRAM probes |
| **Runtime** | Scan llama.cpp runtimes; Automatic Optimizer vs CPU Safe |
| **Models** | Local GGUF catalog/import; online catalog; health checks; API key test/save |
| **Organization Server** | OpenAI-compatible base URL + bearer token; model list; server chats |
| **Image Studio** | Online image generation (when configured); honest offline catalog labels |
| **Diagnostics** | Pass / warn / fail operational checks |
| **Characters** | Personas applied to chat |
| **Prompts** | Prompt library |
| **Storage** | Local counts, orphan cleaner, batch helpers, SHA256 verify (feature-flagged) |
| **Backup** | Export/import; encrypted and scheduled backup options |
| **Settings** | General, providers, MCP, deployment, security (incl. OCR / Image RAG opt-in), audit, advanced |
| **Help** | Operator-facing troubleshooting |

### Settings tabs (detail)

- **Providers** — vaulted keys; validate-before-save; supports Groq, Cerebras, OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Mistral, Together, and related OpenAI-compatible endpoints.  
- **MCP** — enable servers; list tools; Connect Cursor / Sync to Cursor (writes project `.cursor/mcp.json`).  
- **Deployment** — data root, models dir, SOC/export paths, GPU layers, context, embedding/reranker paths.  
- **Security** — confidence thresholds, audit toggle, HyDE/query expand, KC profile demo/server, OCR engine/preprocess (default on), **online Image RAG master switch (default off)**.  
- **Audit** — local activity log view/export when enabled.

---

## 6. Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  React UI (Vite)                                            │
│  Chat · SOC · Knowledge Chat · PocketCode · Runtime · …     │
└──────────────────────────┬──────────────────────────────────┘
                           │ Tauri IPC commands
┌──────────────────────────▼──────────────────────────────────┐
│  Rust backend (src-tauri)                                   │
│  llm/ (local + remote) · knowledge_chat/ · mcp_host         │
│  code_workspace / cw_* · deployment · crypto vault · SQLite │
└───────────────┬───────────────────────┬─────────────────────┘
                │                       │
                ▼                       ▼
     llama-server (GGUF)      Online / Org OpenAI-compatible APIs
     CPU · CUDA · Vulkan · Metal
```

### Knowledge Chat answer path (simplified)

1. Intent classification (file purpose, symbol explain, general, …)  
2. Hybrid retrieval (FTS + dense when embeddings exist)  
3. Rerank (Qwen RANK → dense-pair → ONNX/phrase)  
4. Structured / extractive answer when evidence is deterministic  
5. Otherwise grounded LLM synthesis from attached sources only  
6. Confidence / grounding gates; evidence fallback if generation is weak  

### PocketCode tool path

1. Choose model → `toolProtocolForModel` selects `native` or `json`  
2. Agent loop streams generation; native path consumes `tool_calls` chunks  
3. Permission overlay for tool execution  
4. Results appended as OpenAI-shaped `role: tool` messages; providers remap to Anthropic `tool_result` or Gemini `functionResponse` in Rust  

### Data on disk (typical)

Honors `NEXUS_DATA_ROOT`. Windows new installs prefer `%LOCALAPPDATA%\PocketMind`. Existing `D:\nexus-ai-deep-fixed\runtime-data` or legacy `D:\NexusAI` trees are still detected so upgrades do not orphan data.

```text
<data-root>/
  models/           # chat, embeddings, rerankers (.gguf)
  app-data/         # SQLite application DB
  knowledge-chat/   # indexes / vectors
  company-data/     # SOC / company roots
  exports/
  cache/
  qa-corpus/        # optional eval corpus sync
```

---

## 7. How to run (development)

### Prerequisites

| Tool | Notes |
|------|--------|
| Node.js | 18+ (20 recommended) |
| Rust | 1.70+ via rustup |
| Platform toolchain | MSVC on Windows; Xcode CLT on macOS; build essentials on Linux |

### Windows (recommended daily loop)

```bash
npm install
npm run setup:windows-runtimes
npm run verify:windows-runtimes
npm run fetch:tooling
npm run tauri:dev:low-mem
```

### macOS / Linux

```bash
npm install
npm run setup:macos-runtimes   # or setup:linux-runtimes
npm run tauri:dev:macos        # or tauri:dev:linux
```

### Useful scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Typecheck + Vite production bundle |
| `npm run test:kc-selftest` | Knowledge Chat TypeScript selftests |
| `npm run test:tool-protocol` | Smoke native vs JSON protocol selection |
| `cargo test knowledge_chat` | Rust KC unit tests (from `src-tauri`) |
| `npm run dist:stage:windows` | Stage client payload after `tauri build` |

Optional debug logging for Rust agent instrumentation: set `NEXUS_AGENT_DEBUG=1` (writes under `%LOCALAPPDATA%\PocketMind\logs\agent-debug.ndjson`, never to a hardcoded repo path).

---

## 8. How to ship (operations)

1. Complete [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) (includes providers, PocketCode native/JSON, MCP, Knowledge Chat smoke).  
2. `npm run tauri build`  
3. `npm run dist:stage:windows` (or macOS/Linux stage scripts)  
4. Zip **only** `distribution/<platform>-desktop/payload/` — see [`distribution/CLIENT_HANDOFF.md`](distribution/CLIENT_HANDOFF.md)  
5. Deliver models separately under NDA; never embed customer corpora  

**Out of scope for the Windows RC freeze but documented:** code signing / notarization for public distribution; Tauri auto-updater (currently off — updates are manual); full Android Play / enterprise-server pilot install (see `android/PLAY_RELEASE_CHECKLIST.md` and `enterprise-server/README_START_HERE.md`).

Legacy path `deploy-package/` is superseded by `distribution/`. One-time C:→D: migration scripts live under `scripts/ops-archive/` and are not client deliverables.

---

## 9. Codebase map — purpose of major areas

### Frontend (`src/`)

| Path | Role |
|------|------|
| `App.tsx`, `main.tsx`, `store.ts`, `types.ts` | Boot, global state, view IDs |
| `components/` | All major UI surfaces (Chat, SOC, KC, PocketCode, Settings, …) |
| `knowledgeChat/` | Client-side answer pipeline, retrieval decisions, prompts, selftests |
| `codeWorkspace/` | Tool schemas, agent modes/prompts, MCP helpers |
| `api/` | Thin Tauri invoke wrappers |
| `apiProviders.ts`, `modelCatalog.ts`, `apiKeyValidation.ts` | Online catalog + key probe UX |
| `deploymentConfig.ts`, `platformPaths.ts`, `productConfig.ts` | Paths and product security defaults |
| `featureFlags.ts` | Capability switches (PocketCode, backup, sandbox, …) |
| `soc*.ts` | Fortinet Copilot logic, validators, templates, intake |

### Backend (`src-tauri/src/`)

| Path | Role |
|------|------|
| `main.rs`, `commands.rs` | Tauri command registration and core IPC |
| `llm/` | Local llama-server client, remote providers, runtime discovery |
| `knowledge_chat/` | Index, FTS, embeddings, rerank, eval, OCR/image RAG, QA corpus |
| `mcp_host.rs` | MCP stdio JSON-RPC host + Cursor bridge helpers |
| `code_workspace.rs`, `cw_*.rs`, `sandbox_runners.rs` | PocketCode filesystem, plans, checkpoints, sandbox |
| `deployment.rs` | Data roots and deployment config |
| `crypto.rs` | Device-bound AES-GCM vault for API keys |
| `database.rs`, `models.rs`, `hardware.rs`, `audit.rs` | Persistence, model records, hardware, audit |
| `power_features.rs` / `power_commands.rs` | Backup, storage power tools, MCP/CW commands |
| `tooling.rs` | Bundled rg/python/node helpers |

### Packaging and ops

| Path | Role |
|------|------|
| `distribution/` | Per-OS desktop/server stage scripts and client docs |
| `enterprise-server/` | Optional org LLM + full-RAG gateway stacks |
| `scripts/` | Runtime installers, low-mem tauri dev, tooling fetch |
| `scripts/ops-archive/` | Historical migration/cleanup scripts (not for clients) |
| `test-fixtures/kc-qa-corpus/` | Intentional RAG evaluation corpus |
| `android/` | Companion app (folder-online constrained by feature flag) |
| `docs/` | Roadmaps and archive (`docs/archive/`) |
| `.github/workflows/ci.yml` | `npm run build`, KC selftests, tool-protocol smoke, `cargo test knowledge_chat` |

---

## 10. Security and compliance posture

- **Local-first:** chat and Knowledge Chat can run without any network.  
- **Vaulted secrets:** API keys and org tokens encrypted at rest via `crypto.rs`; raw keys are not returned to the UI after save.  
- **Audit log:** optional local activity trail (Settings → Security / Audit).  
- **Tool confirmation:** PocketCode and MCP tool executions go through a permission overlay.  
- **SOC disclaimer:** generated artifacts are drafts for human approval — the app does not silently push to FortiSIEM/FortiSOAR.  
- **Image RAG / online vision:** master switch defaults **off**; requires explicit enablement.  
- **No silent model failover:** product rule across chat and agent paths.  
- **Release hygiene:** client zips exclude `.git`, source, `runtime-data` customer content, and GGUF weights unless intentionally added.  
- **Debug logging:** disabled unless `NEXUS_AGENT_DEBUG=1`; never hardcodes a developer machine path.

This is not a formal certification claim (SOC2/ISO). It is an engineering posture suitable for private pilots and regulated evaluations when paired with customer IT review (`enterprise-server/SECURITY_CHECKLIST.md`).

---

## 11. Capabilities matrix

| Capability | Local GGUF | Online providers | Organization server |
|------------|------------|------------------|---------------------|
| Chat | Yes | Yes | Yes |
| Streaming | Yes | Yes (provider-dependent) | Yes |
| Vision attachments | Model-dependent | Provider/model-dependent | Endpoint-dependent |
| PocketCode native tools | No (JSON protocol) | OpenAI-compat + Anthropic + Gemini | OpenAI-compat (`enterprise:`) |
| Knowledge Chat retrieval | On-device index | Uses local index; generation may use selected model | Same |
| Air-gap | Yes | No | Yes if server is on-prem |
| MCP | Local host | Local host | Local host |

**PocketCode local model policy:** agent modes expect capable models (product guidance: local ≥ ~30B class for reliable JSON tool use). Smaller models may need repair turns or clearer “too small” messaging.

---

## 12. Investor thesis — why invest, why now

### Market

Three markets are converging: **private/local AI**, **vertical security copilots**, and **coding agents**. Enterprises want GenAI productivity without surrendering incident data, source code, or regulated corpora to consumer SaaS. Governments and MSPs need portable, auditable tools that work in constrained networks.

### Moat

- Full-stack desktop product (UI + Rust RAG + runtime manager + agent + SOC), not a thin wrapper around one API.  
- Vertical Fortinet/SOC workflows that general chat apps do not ship.  
- Hybrid inference with explicit trust boundaries and packaging discipline.  
- Retrieval quality investments (hybrid search, rerank, confidence gates, eval harness) that compound with customer corpora.

### Go-to-market

1. **Desktop pilot** — Windows portable package to a SOC or engineering team  
2. **Expand corpus + PocketCode** — company knowledge + repo agent in the same install  
3. **Enterprise server** — when 70B-class or shared GPU servers are justified (`enterprise-server/`)  
4. **Land and expand** via MSPs who re-package for multiple clients  

### Why now

Frontier models finally make **native tool calling** reliable enough for agent loops; open GGUF ecosystems make **local** quality viable; and security buyers are actively rejecting “just paste into ChatGPT.” PocketMind sits at that intersection with a shippable Windows RC and a clear server upsell.

### Risks (honest)

- Runtime/GPU variability across client machines (mitigated by Automatic Optimizer + CPU Safe).  
- RAG quality depends on corpus hygiene and model fit (mitigated by eval panel + confidence gates).  
- Signing/updater maturity still needed for mass consumer distribution.  
- Research roadmap items (ColBERT, trained ONNX intent, CI recall gates) remain post-v1.

---

## 13. What’s next (roadmap)

Documented as **post-v1**, not ship blockers:

- Knowledge Chat: ColBERT code partition, remove hash-vector lexical path, train/export ONNX intent classifier, CI recall@5 / MRR gates, confidence calibration, optional LLM polish for structured answers (`docs/knowledge-chat-next-phases.md`).  
- Product ops: code signing, notarization, optional Tauri updater, deeper automated UI e2e.  
- Mobile: Android companion hardening per Play checklist.  
- Enterprise: fuller full-RAG gateway pilots with customer IT security review.

---

## 14. FAQ and troubleshooting pointers

| Question | Where to look |
|----------|----------------|
| How do I package for a client? | `distribution/CLIENT_HANDOFF.md`, `CLIENT_SHIPPING.md` |
| How do I connect an org LLM? | `ENTERPRISE_SERVER_MODE.md`, Organization Server view |
| Knowledge Chat architecture? | `KNOWLEDGE_CHAT.md` |
| Fortinet demo script? | `FORTINET_SOC_DEMO_GUIDE.md` |
| Release QA? | `RELEASE_CHECKLIST.md` |
| Mac / Linux builds? | `MAC_BUILD_GUIDE.md`, `LINUX_BUILD_GUIDE.md` |
| Production operator short guide? | `PRODUCTION_READINESS.md` |
| Historical repair notes? | `docs/archive/` |

**Common fixes**

- Runtime missing → Settings/Runtime scan; re-run `setup:*-runtimes`.  
- Model won’t fit → Automatic Optimizer / CPU Safe; clearer fit errors instead of crash.  
- Weak KC answers → rebuild index; check embedding/reranker paths; enable Server profile on strong hardware.  
- Agent ignores tools → ensure capable model; native providers for cloud; JSON repair prompts for local.  
- MCP fails → confirm server enabled; approve tool in overlay; check Cursor bridge logs for roots URI quirks on Windows.

---

## 15. Closing statement

PocketMind Hybrid AI is ready to be evaluated as a **deployment-grade hybrid AI workstation**: local inference, grounded knowledge, SOC copiloting, and an agentic coding workspace with modern tool protocols — packaged so clients receive a payload, not a research repo. Use this guide as the single narrative; use the linked checklists as the execution spine for each release.

**Maintainers:** keep this file updated when AppViews, providers, packaging paths, or security defaults change. Version at top of file should match `package.json` / `tauri.conf.json`.
