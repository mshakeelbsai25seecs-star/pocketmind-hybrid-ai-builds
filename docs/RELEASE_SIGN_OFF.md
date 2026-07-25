# Release sign-off — 1.0.0

Generated during the deployment readiness hardening pass.

## Automated (passed on build machine)

- [x] Junk / session artifacts removed; `.gitignore` tightened
- [x] `debug_session` gated behind `NEXUS_AGENT_DEBUG` (no hardcoded repo paths)
- [x] Portable Windows data root for new installs (`%LOCALAPPDATA%\PocketMind`) with legacy/dev detection
- [x] `npm run build`
- [x] `npm run test:kc-selftest`
- [x] `npm run test:tool-protocol` (anthropic/gemini/groq → native; local → json)
- [x] `cargo check` (src-tauri)
- [x] `cargo test knowledge_chat` (147 passed)
- [x] `PRODUCT_GUIDE.md` authored (~2888 words) + README / CLIENT_HANDOFF links
- [x] Version bumped to `1.0.0` (package.json, Cargo.toml, tauri.conf.json; MSI requires numeric-only versions)
- [x] CI workflow runs KC selftests + tool-protocol smoke
- [x] `RELEASE_CHECKLIST.md` sections 11–14 added (providers, PocketCode, MCP, KC)

## Manual UI matrix (operator must tick on a real Windows session)

Use root [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md) sections 1–14. At minimum before client zip:

- [ ] Staged payload boots (`dist:stage:windows` after `tauri build`)
- [ ] Local chat one-liner + stop
- [ ] One online provider chat (if key available)
- [ ] PocketCode one native tool turn + permission overlay
- [ ] MCP list/call with confirm
- [ ] Knowledge Chat index + 3 questions with sources
- [ ] SOC practice scenario → validators

## Packaging

- [x] `tauri build` produced release exe + NSIS + MSI (`1.0.0`; earlier `1.0.0-rc.1` rejected by WiX)
- [x] `npm run dist:stage:windows` payload includes exe, `PocketMind Hybrid AI_1.0.0_x64-setup.exe`, MSI, `bin/llama.cpp/{cpu,cuda,vulkan}`, docs, `PRODUCT_GUIDE.md`
- [x] Payload does not include `.git` / source tree

## Definition of Done (plan Workstream E)

1. [x] Junk/legacy cleanup; gitignore tightened; `debug_session` does not write hardcoded developer paths  
2. [x] Path defaults portable for new installs (`%LOCALAPPDATA%\PocketMind`)  
3. [x] `npm run build` + KC cargo tests + selftests + tool-protocol smoke  
4. [ ] Full RELEASE_CHECKLIST UI matrix (operator) — automated portions done; interactive rows remain  
5. [x] Staged Windows portable payload with exe + runtimes + PRODUCT_GUIDE (interactive smoke of the staged folder remains for operator)  
6. [x] `PRODUCT_GUIDE.md` ≥2000 words (~2888) with required sections  
7. [x] README + CLIENT_HANDOFF point to PRODUCT_GUIDE; deferred KC research phases documented as post-v1
