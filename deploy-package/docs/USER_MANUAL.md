# PocketMind Hybrid AI User Manual

## What is PocketMind Hybrid AI?

PocketMind Hybrid AI is a desktop application for security analysts. It helps you triage alerts, draft FortiSIEM/FortiSOAR artifacts, validate parser/playbook XML, and ask questions about **your company's own policies and SOPs** — using AI that runs on your organization's server, not in the public cloud.

## Before you start

1. Your IT team must install PocketMind Hybrid AI and configure server paths (**Settings → Deployment**).
2. An admin must index the company data folder (**SOC → Knowledge → Scan & Index**).
3. You must select a local AI model (**Models**).

## Main areas

### Home
Overview and shortcuts to SOC, Knowledge Chat, Chat, and Models.

### SOC
Alert queue, investigation, Fortinet engineering tools, and company knowledge. Fresh installs start with an empty queue. Cases persist under the deployment data root in `soc/`.

**Investigate an alert**
1. Open **SOC → Queue**.
2. **Import** FortiSIEM/CEF/CSV/XML exports, or create a blank case and paste evidence.
3. Open the case → **Investigate** (requires a selected model).
4. Review the evidence chain and verdict; override disposition if needed.
5. Approve / close with your name for the audit log; **Export** the case report when needed.

**Engineering (rules / parsers / playbooks)**
1. Open **SOC → Workspace** (or Validators / Reports).
2. Draft FortiSIEM/FortiSOAR artifacts with company knowledge grounding.
3. Run **Validators** for local parser/playbook checks (deterministic, not AI).

### Knowledge Chat
Ask plain-language questions about indexed company folders. Answers cite source files.

### Chat
General conversations. SOC Workspace prompts can open here automatically.

### Models
Import and select GGUF models stored on the server.

### Settings → Deployment
*(Admins)* Configure where data and models live on the server.

## Important rules

- AI recommendations require **human approval** before production actions.
- The app does **not** call live FortiSIEM/FortiSOAR APIs in this build — use Import or paste exports.
- If answers seem generic, ask an admin to **re-index** the company folder.

## Getting help

See `TROUBLESHOOTING.md` in this package or contact your internal PocketMind Hybrid AI administrator.
