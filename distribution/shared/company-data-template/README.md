# Company data folder template

Place sanitized, import-ready SOC artifacts under your configured `company-data` root. Default intake subfolder: `{data_root}/company-data/intake/`.

## Suggested subfolders

```
company-data/
├── intake/
│   ├── policies/
│   ├── sops/
│   ├── runbooks/
│   ├── rules/           # FortiSIEM rules (XML)
│   ├── parsers/         # Parser definitions
│   ├── playbooks/       # FortiSOAR-style JSON
│   ├── connectors/
│   ├── sample-logs/
│   ├── alerts/
│   └── evaluation/      # TP/FP examples
├── policies/
├── sops/
└── runbooks/
```

## Rules

- Do **not** index secrets, credentials, API keys, or unsanitized PII.
- Keep raw received files separate from sanitized import-ready copies.
- After copying files: **Grounded SOC Knowledge → Scan & Index** or **Company Data Intake → Scan Intake Folder**.

## Path configuration

Set roots in **Settings → Deployment** or via `NEXUS_SOC_DATA_ROOT` / `NEXUS_DATA_ROOT` environment variables.
