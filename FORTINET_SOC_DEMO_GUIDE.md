# Nexus SOC Offline — Fortinet R&D Copilot Demo Guide

## 1. Product positioning

**Nexus SOC Offline — Fortinet R&D Copilot** is a local desktop prototype built from the existing Nexus AI app. It is designed as an offline SOC L3 and R&D copilot for Fortinet-focused environments.

The prototype helps analysts and SOC engineers prepare, review, and document work around:

- FortiSIEM alert triage and investigation planning
- FortiSIEM rule drafting and tuning notes
- FortiSIEM parser planning and sample-log analysis
- FortiSOAR playbook planning and connector requirements
- offline Fortinet/company knowledge registration and basic keyword retrieval
- deterministic validation checks for XML, JSON, regex, IOCs, rules, and playbooks
- local Markdown report generation and safe local export

This prototype should be presented as a **human-approved analyst/R&D copilot**, not as a production replacement for FortiSIEM, FortiSOAR, or a live SOAR automation engine.

## 2. Implemented prototype phases

### Phase 1 — SOC workspace skeleton

Added the SOC Offline workspace with structured inputs for alert summary, raw logs, source IP, destination IP, username, asset/device, severity, and rule/playbook/parser notes. It also added SOC prompt workflows for triage, investigation planning, FortiSIEM rules, FortiSIEM parsers, FortiSOAR playbooks, connector requirements, offline knowledge search, and human approval guidance.

### Phase 2 — Offline Knowledge Base metadata library

Added local metadata registration for Fortinet/company resources from configured deployment paths. Supported metadata includes title, category, product, version, tags, file path, and notes. The library supports local filtering and selected resources can be appended to SOC prompts.

### Phase 3 — Basic local text indexing and keyword retrieval

Added offline indexing for safe text-based files only: TXT, LOG, MD/MARKDOWN, CSV, JSON, XML, YAML/YML, and HTML/HTM. The app stores index status, indexed time, character count, chunk count, warnings, and local text chunks. It supports keyword retrieval over indexed chunks and can append selected snippets to SOC prompts.

This is **basic local keyword retrieval**, not semantic vector RAG.

### Phase 4 — SOC Validators / Engineering Checks

Added deterministic local validators and utilities for FortiSIEM parser XML, FortiSOAR-style JSON, a basic YAML checklist, regex testing, IOC extraction, FortiSIEM rule review, FortiSOAR playbook review, and unsafe-action warnings. Validator reports can be copied or reviewed in local Chat.

### Phase 5 — SOC Reports / Artifact Export drafts

Added local Markdown report templates for SOC triage reports, investigation plans, FortiSIEM rule drafts, FortiSIEM parser drafts, FortiSOAR playbook drafts, connector specs, offline knowledge summaries, and validator summaries.

### Phase 6 — SOC Dashboard / Command Center

Added a demo-ready dashboard with offline status, knowledge/resource counts, indexed chunk counts, selected context counts, validator/report readiness, prototype scope, analyst workflow, and presentation talking points.

### Phase 7 — Demo Mode / Sample Data

Added clearly labeled demo-only sample data for a VPN brute-force alert, generic FortiGate/FortiSIEM-style logs, FortiSIEM rule notes, FortiSIEM parser notes, FortiSOAR playbook notes, connector requirement notes, and validator demo payloads. These samples are not real customer data and are not official Fortinet exports.

### Phase 8 — Safe local file export

Added a small audited Tauri export command for UTF-8 text exports. Exports must fall under configured NexusAI data roots (see **Settings → Deployment**). Extensions are restricted to `.md`, `.txt`, `.json`, and `.xml`, and silent overwrite is prevented by default.

### Phase 9 — Presentation polish

Added quick-jump navigation, a compact demo flow, readiness checklist, helper text, and section anchors to make the SOC prototype easier to present.

### Phase 10 — Final handover hardening

Added this handover/readiness guide and a visible SOC Offline handover card in the app so presenters know exactly what is implemented, what is intentionally not implemented, and how to demonstrate the prototype safely.

## 3. Offline and privacy guarantees

The SOC prototype is designed around local/offline workflows:

- SOC prompts are generated locally in the frontend.
- Knowledge metadata is stored locally.
- Safe text indexing and keyword retrieval run locally.
- Validators run locally and deterministically.
- Reports are generated as local Markdown text.
- Exports are written only through the safe local export command.
- Demo sample data is bundled locally in the UI.

The prototype does not require internet access for the SOC workflow. Any optional online model/provider behavior from the broader Nexus AI app should not be used during the Fortinet SOC offline demo unless the company explicitly approves it.

## 4. What is intentionally not implemented

The prototype intentionally does **not** implement:

- live FortiSIEM API integration
- live FortiSOAR API integration
- automatic containment or production response actions
- direct disabling of accounts, blocking of IPs, deleting files, or changing production systems
- semantic vector RAG
- full PDF/DOCX parsing inside the SOC knowledge base
- role-based approvals
- production audit logging
- multi-user enterprise access control
- official Fortinet content packs or official Fortinet exports bundled with the prototype

These are roadmap items or customer-data-dependent features, not current prototype claims.

## 5. Path policy and export restrictions

All SOC scan, index, OCR, embedding, and export paths must stay under configured NexusAI deployment roots.

Configure in **Settings → Deployment** or via `NEXUS_DATA_ROOT` and related environment variables (see `distribution/shared/config/deployment.env.example`).

Default data roots:

| Platform | Default |
|----------|---------|
| Windows | `C:\ProgramData\NexusAI` |
| Linux | `/var/lib/nexusai` |
| macOS | `~/Library/Application Support/NexusAI` |

Supported export extensions:

- `.md`
- `.txt`
- `.json`
- `.xml`

## 6. Suggested company demo walkthrough

Use this order during the demo:

1. Open Nexus AI and go to **SOC Offline**.
2. Start at the **Dashboard / Command Center** and explain the offline/local-only positioning.
3. Show the **Prototype Scope** panel: no live FortiSIEM/FortiSOAR integration yet, no autonomous response actions, basic keyword retrieval only.
4. Open **Demo Mode** and load the VPN brute-force demo sample.
5. Show the filled SOC workspace fields.
6. Generate a SOC triage or investigation prompt.
7. Use **Open in Chat** to review the generated prompt with a local model.
8. Register one company knowledge resource in the **Offline Knowledge Base** (under your configured `company-data` path).
9. Index a safe text file such as `.txt`, `.log`, `.json`, or `.xml`.
10. Search retrieved snippets and select relevant context.
11. Run **Validators** using demo XML/JSON/regex/IOC payloads.
12. Generate a **Markdown SOC Report**.
13. Export the report to your configured export folder.
14. End with the human-approval warning: the app recommends and drafts, but does not execute production response actions.

## 7. Testing checklist before presentation

Run these checks before presenting:

- [ ] `npm run build` passes.
- [ ] `npm run tauri dev` opens the app.
- [ ] SOC Offline opens from the sidebar.
- [ ] Dashboard cards render correctly.
- [ ] Demo Mode can fill the SOC workspace.
- [ ] SOC prompt generation works.
- [ ] Open in Chat loads the generated SOC prompt.
- [ ] A company knowledge resource can be registered under configured paths.
- [ ] A safe text file can be indexed.
- [ ] Keyword retrieval returns snippets.
- [ ] Selected metadata/snippets append to SOC prompts.
- [ ] Validators run for XML, JSON, regex, IOCs, rule notes, and playbook notes.
- [ ] Reports generate Markdown.
- [ ] Export to a configured export path works.
- [ ] Export to paths outside deployment roots is rejected.
- [ ] UI clearly says human approval is required.
- [ ] UI does not claim live FortiSIEM/FortiSOAR integration.
- [ ] UI labels retrieval as basic keyword retrieval, not semantic vector RAG.

## 8. Data the company should provide next

To turn this prototype into a strong Fortinet-specific pilot, request:

- FortiSIEM version number and deployment context
- FortiSOAR version number and deployment context
- approved FortiSIEM documentation exports
- approved FortiSOAR documentation exports
- internal SOC SOPs and escalation procedures
- existing FortiSIEM rules
- existing FortiSIEM parsers
- existing FortiSOAR playbooks
- connector documentation and connector inventory
- sample incidents and alert records
- sample raw logs from common devices
- true-positive and false-positive examples
- MITRE ATT&CK mapping preferences
- severity and escalation policy
- response approval policy
- allowed export/storage locations

## 9. Suggested future roadmap

Recommended next development phases:

1. Full local RAG pipeline with chunk database and better retrieval ranking.
2. PDF/DOCX extraction using a stable offline parser.
3. Local semantic embeddings for Fortinet/company knowledge.
4. Retrieval citations inside SOC answers and reports.
5. Version-aware FortiSIEM/FortiSOAR knowledge packs.
6. Optional FortiSIEM API integration for read-only alert/context import.
7. Optional FortiSOAR API integration for draft playbook validation/import, not automatic execution.
8. Role-based human approval workflows.
9. Audit logs for report exports and analyst decisions.
10. Team/enterprise deployment hardening.

## 10. Final demo positioning statement

Use this concise statement in meetings:

> Nexus SOC Offline is a fully local Fortinet SOC L3/R&D copilot prototype. It helps analysts triage alerts, prepare investigation plans, draft FortiSIEM rules and parsers, plan FortiSOAR playbooks, register and search local SOC knowledge, run deterministic validators, and export Markdown artifacts. It does not replace FortiSIEM or FortiSOAR, and it does not execute production response actions. It is designed for offline, human-approved SOC engineering workflows using company-provided data.

## 11. Final recommendation

The prototype is demo-ready for an R&D/company walkthrough if the Phase 1-10 checklist passes on your configured deployment paths. For a real pilot, the next critical step is to ingest approved company-provided FortiSIEM/FortiSOAR documentation, rules, parsers, playbooks, connectors, and incident examples.
