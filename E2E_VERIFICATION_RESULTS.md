# E2E Verification Results (automated + static)

**Build under test:** `0789936` + local uncommitted UI/catalog/Settings fixes  
**Date:** 2026-07-25  
**Data root observed:** `D:\NexusAI`  
**Models present:** Phi-3 Mini Q4 (~1.1 GB), Llama-3.1-8B partial stub, Qwen2-VL 2B partial download  

This pass covers what can be proven without full interactive desktop clicks. You finish Suites 0–10 UI steps in [`E2E_TEST_PLAN.md`](E2E_TEST_PLAN.md).

---

## Automated gates

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run build` (tsc + vite) | **PASS** | Clean production build |
| `npm run test:kc-selftest` | **PASS** | All KC selftests passed |
| `npm run test:tool-protocol` | **PASS** | anthropic/gemini/groq → native; GGUF → json |
| `cargo test --tests` | **PASS** | 155 passed, 0 failed |
| `npm run verify:windows-runtimes` | **PASS** | cpu / cuda / vulkan llama-server OK |
| Offline catalog unique IDs | **PASS** (after fix) | 33 unique offline entries |

---

## Static / code verification (Suites mapped)

### Suite 0 — Shell / nav
| ID | Status | Notes |
|----|--------|-------|
| 0.1–0.7 | **YOU** | Needs live app: cold start, sidebar walk, footer, hotkey |

### Suite 1 — Runtime / Diagnostics
| ID | Status | Notes |
|----|--------|-------|
| 1.1–1.5 | **YOU** | Runtime Manager UI |
| 1.6 | **YOU** | Hardware monitor |
| 1.7–1.12 | **PARTIAL** | `get_runtime_diagnostics` + report copy implemented; runtimes verified on disk. Live Run checks / tok/s still need UI |

### Suite 2 — Settings
| ID | Status | Notes |
|----|--------|-------|
| 2.1–2.3 | **YOU** | Theme / accent / performance |
| 2.4 Get key | **CODE PASS** | Uses `openExternal` / Tauri soft-fail (no false alert path) — retest in UI |
| 2.5–2.7 | **YOU** | DeepSeek key Test/Save (402 = expected if no balance) |
| 2.8–2.11 MCP | **YOU** | |
| 2.12–2.16 Deployment | **PARTIAL** | Paths resolve under `D:\NexusAI` on disk; Save/Reload UI = you |
| 2.17–2.23 Security/Audit | **YOU** | |
| 2.24 Open Folder | **FIXED** | Wired to open `dataRoot` via shell |
| 2.25 Debug report | **FIXED** | Copies runtime diagnostics to clipboard |
| 2.26 App version | **FIXED** | Was hardcoded `0.1.0`; now from `get_system_info` → expect `1.0.0` |
| 2.27 Reset | **DOCUMENTED** | No factory-wipe backend; button explains manual data-root removal |

### Suite 3 — Offline models + Chat
| ID | Status | Notes |
|----|--------|-------|
| 3.1–3.3 | **YOU** | Phi-3 already on disk; VL download incomplete (`.part`) |
| 3.4 Duplicate Download | **FIXED** | Duplicate catalog IDs removed (`qwen25-coder-32b-q4`, `llama33-70b-instruct-q4`); quant buttons show params |
| 3.5–3.7 | **YOU** | Use / Health / paths |
| 3.8–3.15 Chat matrix + export | **PARTIAL** | Export kinds code-confirmed: **md / json / txt only** (no PDF). Compare = manual DiffViewer. Generation matrix = you |
| 3.16 Characters | **YOU** | |

### Suite 4 — Online providers
| ID | Status | Notes |
|----|--------|-------|
| 4.1–4.7 | **YOU** | Catalog has DeepSeek V4 Pro/Flash; 402 without credits is expected |

### Suite 5 — Knowledge Chat
| ID | Status | Notes |
|----|--------|-------|
| 5.x logic | **PARTIAL** | Rust KC tests + JS selftests green; index/ask/eval UI = you |
| Embeddings/rerankers dirs | **PRESENT** | `D:\NexusAI\models\embeddings`, `...\rerankers` |

### Suite 6 — Fortinet SOC
| ID | Status | Notes |
|----|--------|-------|
| 6.1–6.8 | **YOU** | `D:\NexusAI\company-data` exists |

### Suite 7 — PocketCode + MCP
| ID | Status | Notes |
|----|--------|-------|
| 7.5 folder invent | **CODE PASS** | Prompt forbids inventing `new_folder/` |
| 7.9–7.10 Restore | **CODE PASS** | Empty checkpoint → honest message; Restore gated on real edits |
| 7.13–7.14 Protocols | **PASS** | Native tools for anthropic/gemini/deepseek/groq |
| Rest of 7.x | **YOU** | Live agent run |

### Suite 8 — Org Server + Image Studio
| ID | Status | Notes |
|----|--------|-------|
| 8.1–8.5 | **YOU** | Needs org endpoint |
| 8.6–8.9 | **PARTIAL** | Image Studio Open uses `openExternal` — retest no false alert |

### Suite 9 — Characters / Prompts / Backup / Storage / Help / Home
| ID | Status | Notes |
|----|--------|-------|
| 9.1–9.17 | **YOU** | Full UI |

### Suite 10 — Cross-cutting
| ID | Status | Notes |
|----|--------|-------|
| 10.1–10.2 Links | **CODE PASS** | Settings, Models, Chat markdown, KC markdown, Image Studio |
| 10.6 Dup downloads | **FIXED** | Retest Models → Quantization switch |
| 10.3–10.5, 10.7 | **YOU** | |

---

## Defect table (this pass)

| ID | Sev | Suite | Issue | Status |
|----|-----|-------|-------|--------|
| D1 | S2 | 2.26 | Advanced Settings showed App Version `0.1.0` | **Fixed** — live `get_system_info` |
| D2 | S2 | 3.4 / 10.6 | Duplicate `Download Q4_K_M` from duplicate catalog IDs | **Fixed** — removed dup IDs; button labels include params |
| D3 | S1 | 2.24 / 2.25 | Advanced Open Folder / Debug Report were dead buttons | **Fixed** — open data root + clipboard diagnostics |
| D4 | S2 | 2.27 | Reset Application has no backend | **Documented** — alert + copy; not a silent no-op |
| D5 | — | 4.3 | DeepSeek HTTP 402 Insufficient Balance | **Expected** when account has no credits |
| D6 | S3 | 3.3 | Qwen2-VL 2B download left as `.part` | Incomplete download on disk — resume/retry in UI |
| D7 | S2 | 9.8 | Restore dialog filtered `*.pmbk` but backups write `*.pmbak` | **Fixed** — dialog accepts `pmbak` (+ legacy `pmbk`) |

---

## Recommended manual order for you

1. Reload app (pick up Settings/catalog fixes).
2. Suite **0** sidebar smoke (5 min).
3. Suite **2.26 / 2.24 / 2.25** + **2.4 Get key** (confirm no false alert).
4. Suite **3.4** Models quant cards (no twin Q4 buttons).
5. Suite **3** Health + P1–P7 + export MD/JSON/TXT on Phi-3.
6. Suite **4** DeepSeek (expect 402 if unpaid).
7. Suites **5 → 7** as time allows; **6 / 8 / 9** after.

Evidence folder suggestion: `D:\NexusAI\exports\e2e\`
