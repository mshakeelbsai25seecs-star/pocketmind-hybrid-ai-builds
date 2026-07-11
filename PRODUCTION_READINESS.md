# Nexus AI — operator guide

## First-time setup

1. **Settings → Deployment** — confirm where models, company data, and exports are stored.
2. **Models** — add a GGUF chat model and an embedding model for document search.
3. **Fortinet Copilot → Company knowledge** — link your folder and click **Scan & Index**.

## Daily workflow

1. Enter alert details in **Incident input**.
2. Choose what you want to do (triage, rule draft, playbook, etc.).
3. Click **Send to Chat** or generate a report.
4. Use **Validators** for parser/playbook checks and **Reports** for Markdown output.

## Practice scenarios

The **Practice scenarios** section includes synthetic VPN and parser examples. Use **Load into form** to try the workflow without real incident data.

## Settings

| Tab | Purpose |
|-----|---------|
| Deployment | Folders and performance |
| Security | Document match requirements and audit logging |
| Audit | View and export local activity log |

## Security notes

- All processing runs on your machine unless you connect an organization LLM server.
- Human approval is required before response actions in your environment.
- The app does not connect live to FortiSIEM or FortiSOAR unless you paste exported data.
