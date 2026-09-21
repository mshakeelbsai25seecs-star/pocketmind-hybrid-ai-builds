# Microsoft Store / Partner Center — EXE installer return codes
# Product: PocketMind Hybrid AI 1.0.0 (Tauri NSIS setup.exe)
# Install command: <setup.exe> /S
# Architecture: x64

Use these values in Partner Center under installer return codes / custom codes.

## Required scenario codes

| Partner Center scenario | Enter this value | Meaning |
|-------------------------|------------------|---------|
| Installation already in progress | **1618** | Another install is running (`ERROR_INSTALL_ALREADY_RUNNING`). |
| Disk space is full | **112** | Target disk is full (`ERROR_DISK_FULL`). |
| Reboot required | **3010** | Install succeeded; restart needed (`ERROR_SUCCESS_REBOOT_REQUIRED`). |
| Network failure | **1612** | Install source / download unavailable (`ERROR_INSTALL_SOURCE_ABSENT`). Optional extras if the form allows multiple: **12029**, **12030**, **12031** (WinHTTP connect failures). |
| Package rejected during installation | **1625** | Blocked by system / security policy (`ERROR_INSTALL_PACKAGE_REJECTED`). |
| Installation successful | **0** | Success. |

## Miscellaneous install failure

- **Return code:** **1603** (`ERROR_INSTALL_FAILURE` — general fatal install failure)
- **Documentation URL:** `https://noumanshakeil.github.io/`

(If the form requires a more specific doc link, use the same site URL; install help lives on that public download page.)

## Other codes you may also add (optional)

| Code | Scenario |
|------|----------|
| **1602** | User cancelled the installer |
| **1641** | Installer initiated a hard reboot |
| **1707** | Alternate MSI-style success (safe to map as success) |

## Notes

- PocketMind’s Store package is the **NSIS** `*-setup.exe` with silent switch **`/S`**.
- NSIS commonly returns `0` on success and non-zero on abort/failure; Partner Center still wants the standard Windows codes above so the Store / management stack can classify outcomes correctly.
- Do **not** point the Package URL at the private `nexus-ai-deep-fixed` repo. Use the public Release asset on `noumanshakeil.github.io`.
