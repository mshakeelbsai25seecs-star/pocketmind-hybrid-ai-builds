# NexusAI Quick Start (all platforms)

## 1. Install the app

Open the `INSTALL.md` in your platform package (`windows-desktop`, `macos-desktop`, or `linux-desktop`).

## 2. First launch

1. Open NexusAI.
2. Go to **Settings → Deployment**.
3. Review default paths (data, models, company-data, exports).
4. Click **Save** and **Ensure folders exist**.

## 3. Add models (offline chat)

1. Copy GGUF chat models into `{data_root}/models/`.
2. Copy embedding model (e.g. `nomic-embed-text-v1.5.Q4_K_M.gguf`) into `{data_root}/models/embeddings/`.
3. Open **Models** → **Scan Folder** → select a model → **Use in Chat**.

## 4. Add company SOC data

1. Copy sanitized FortiSIEM rules, parsers, playbooks, SOPs into `{data_root}/company-data/` (see `company-data-template/README.md`).
2. **Fortinet Copilot → Grounded SOC Knowledge** → Link folder → **Scan & Index**.
3. Optional: **Company Data Intake** tab for bulk import workflow.

## 5. Run SOC triage

1. **Fortinet Copilot → Workspace** — paste alert/incident details.
2. Retrieved company snippets appear automatically when indexed.
3. Use **Validators** for local rule/parser/playbook checks (not AI).
4. Export reports to `{data_root}/exports/`.

## 6. Knowledge Chat

1. Create a collection pointing at a company-data folder.
2. Scan → Index → ask questions with grounded citations.

## Need help?

- Analysts: platform package `docs/USER_MANUAL.md` (server packages) or desktop `INSTALL.md`
- IT admins: `ADMIN_DEPLOYMENT_GUIDE.md` in server packages
- Issues: `TROUBLESHOOTING.md`
