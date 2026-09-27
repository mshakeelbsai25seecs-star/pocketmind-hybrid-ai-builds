# PocketMind Hybrid AI — operator guide

## First-time setup

1. **Settings → Deployment** — confirm where models, company data, and exports are stored.
2. **Models** — add a GGUF chat model and an embedding model for document search.
3. **SOC → Knowledge** — link your company folder and click **Scan & Index**.

## Daily workflow

1. Open **SOC → Queue** (empty on a fresh install).
2. **Import** FortiSIEM/CEF/CSV/XML exports, or create a blank case and paste evidence.
3. Open the case → **Investigate** (model required) → review evidence chain and verdict.
4. Approve / close with an analyst name for the audit log; export the case report as needed.
5. Use **Workspace / Validators / Reports** for Fortinet rule, parser, and playbook engineering.

## Practice scenarios

**SOC → Practice** can create a case from a sample on demand. Nothing is preloaded into the queue.

## Settings

| Tab | Purpose |
|-----|---------|
| Deployment | Folders and performance |
| Security | Document match requirements and audit logging |
| Audit | View and export local activity log |

## Security notes

- All processing runs on your machine unless you connect an organization LLM server.
- Human approval is required before response actions in your environment.
- The app does not call live FortiSIEM or FortiSOAR APIs in this build. Use Import or paste exports.
- Case data persists under `{data_root}/soc/` (cases, memory, imports, metrics).
