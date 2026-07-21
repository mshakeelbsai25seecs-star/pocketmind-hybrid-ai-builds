# PocketMind Hybrid AI User Manual

## What is PocketMind Hybrid AI?

PocketMind Hybrid AI is a desktop application for security analysts. It helps you triage alerts, draft FortiSIEM/FortiSOAR artifacts, validate parser/playbook XML, and ask questions about **your company's own policies and SOPs** — using AI that runs on your organization's server, not in the public cloud.

## Before you start

1. Your IT team must install PocketMind Hybrid AI and configure server paths (**Settings → Deployment**).
2. An admin must index the company data folder (**Fortinet Copilot → Grounded SOC Knowledge → Scan & Index**).
3. You must select a local AI model (**Models**).

## Main areas

### Home
Overview and shortcuts to SOC, Knowledge Chat, Chat, and Models.

### Fortinet Copilot (SOC)
Your primary workspace for incidents.

**Triage an alert**
1. Open **Fortinet Copilot**.
2. Fill in alert summary, logs, IPs, user, asset, severity.
3. Click **Triage Alert**.
4. Review auto-retrieved company policy snippets.
5. Click **Send to Chat** for the AI answer.

**Generate a report**
1. Scroll to **SOC Reports**.
2. Choose report type and fill in fields.
3. Click **Generate Grounded Report with AI**.
4. Export or copy the Markdown file.

**Validators**
Paste parser XML, playbook JSON, or sample logs. The app runs **local checks** (pass/warning/fail). This is not AI — it is deterministic validation.

### Knowledge Chat
Ask plain-language questions about indexed company folders. Answers cite source files.

### Chat
General conversations. SOC prompts from Fortinet Copilot open here automatically.

### Models
Import and select GGUF models stored on the server.

### Settings → Deployment
*(Admins)* Configure where data and models live on the server.

## Important rules

- AI recommendations require **human approval** before production actions.
- The app does **not** connect live to FortiSIEM/FortiSOAR — you paste exports.
- If answers seem generic, ask an admin to **re-index** the company folder.

## Getting help

See `TROUBLESHOOTING.md` in this package or contact your internal PocketMind Hybrid AI administrator.
