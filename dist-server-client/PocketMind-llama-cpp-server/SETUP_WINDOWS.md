# Windows first-run setup for PocketMind llama.cpp chat server

## Fastest path (recommended)

1. Copy this whole `llama-cpp` folder to the server, e.g. `C:\PocketMindServer\llama-cpp`
2. Install Docker Desktop, NVIDIA driver, and Python 3 (one time)
3. **Double-click `START_ADMIN.cmd`** (not PowerShell from System32)
4. Browser opens `http://127.0.0.1:8090/` — paste the token from the black window
5. Download/select a complete GGUF → **Start**
6. PocketMind Org Server URL on this PC: `http://127.0.0.1:8000/v1`

Also see `START_HERE.txt` in this folder.

| Launcher | Purpose |
|---|---|
| `START_ADMIN.cmd` | Admin UI (download models, start/stop, logs) |
| `START_SERVER.cmd` | Start chat API only (after a valid model is selected) |
| `PREFLIGHT.cmd` | Check Docker / GPU / model file |
| `SMOKE_TEST.cmd` | `curl.exe` test of `/v1/models` |

The `.cmd` launchers:

- Always `cd` into this package folder (fixes “script not found” from System32)
- Use `-ExecutionPolicy Bypass` (fixes “running scripts is disabled” / “not digitally signed”)
- Unblock Mark-of-the-Web on copied scripts

## What you are installing

- **Chat API** on port **8000** (PocketMind Organization Server URL)
- **Admin UI** on port **8090** (download/select models, start/stop, logs)

Keep **Docker Desktop** running when starting the chat container. You do **not** need an Ubuntu terminal open to download GGUFs into `models\`.

## If you insist on PowerShell

```powershell
cd C:\PocketMindServer\llama-cpp
powershell.exe -ExecutionPolicy Bypass -File .\start-admin.ps1
```

Plain `.\start-admin.ps1` often fails on locked machines even after `Set-ExecutionPolicy RemoteSigned` when the file is treated as unsigned / from another computer.

## Download, import, or copy a model

- **Import local GGUF** in the admin UI: paste a full Windows path to a `.gguf` you already have
  (hard-links into `models\` when possible so huge files are not duplicated)
- **App catalog**: pick any PocketMind offline model → **Download**
  (progress shows in MB/GB; interrupted downloads resume from `.part` files)
- Or paste a Hugging Face **direct** `.gguf` URL → Start download
- Or copy a complete `.gguf` into `C:\PocketMindServer\llama-cpp\models\`

Then click **Select** (if needed) on a file marked **valid**, then **Start (auto-optimize)**.

### Interrupted downloads

Do **not** delete `.part` files after a crash/cancel. Run the same Download again —
the admin resumes with HTTP Range and keeps already-fetched data.

### Corrupt / incomplete files

If logs say `corrupted or incomplete` or `data is not within the file bounds`:

1. Delete the bad **completed** file from `models\` (not a still-growing `.part`)
2. Download again and wait until it finishes
3. Confirm size is large (Phi-3 Mini Q4 is usually ~2 GB, not a few MB)

The admin UI and `preflight.ps1` reject empty/tiny/non-GGUF files before start.

## Start the chat server

**Preferred:** Admin UI → **Start (auto-optimize)**

On Start the server:

1. Measures free VRAM (`nvidia-smi`)
2. If the model fits → full GPU offload (`GPU_LAYERS=-1`)
3. If larger → max layers on GPU, remaining layers on CPU/RAM
4. If a try OOMs → steps down layers automatically, then CPU compose as last resort

`START_SERVER.cmd` applies the first plan; Admin Start does the full retry ladder.

To pin layers manually: set `AUTO_OPTIMIZE=0` and `GPU_LAYERS=N` in `.env`.

**Or** double-click `START_SERVER.cmd`

Never run `docker compose` from `C:\Users\...` — the `.env` and `models` folder must be this package directory.

## Test

Double-click `SMOKE_TEST.cmd`, or:

```powershell
curl.exe http://127.0.0.1:8000/v1/models
```

In PowerShell, use **`curl.exe`**, not `curl` (alias for Invoke-WebRequest).

## PocketMind clients

Organization Server URL:

```text
http://SERVER_IP:8000/v1
```

On the server PC itself use `http://127.0.0.1:8000/v1`.

Clients must be able to **ping** the server IP. Campus Wi‑Fi (`10.7.x`) often cannot reach wired labs (`10.4.x`).

## Firewall

```powershell
New-NetFirewallRule -DisplayName "PocketMind llama.cpp 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
New-NetFirewallRule -DisplayName "PocketMind llama admin 8090" -Direction Inbound -Protocol TCP -LocalPort 8090 -Action Allow
```

## Stop

Admin UI → **Stop**, or:

```powershell
cd C:\PocketMindServer\llama-cpp
docker compose --env-file .env -f docker-compose.cuda.yml down
```

## Common failures (from real setup)

| Symptom | Cause | Fix |
|---|---|---|
| `.\start-admin.ps1` not recognized in System32 | Wrong folder | `cd` to `llama-cpp` or use `START_ADMIN.cmd` |
| Running scripts is disabled | ExecutionPolicy | Use `START_ADMIN.cmd` |
| Not digitally signed | Unsigned + strict policy / MOTW | Use `START_ADMIN.cmd` or Bypass `-File` |
| `couldn't find env file: C:\Users\…\.env` | Wrong directory for compose | Stay in package folder |
| `No such file` / corrupt GGUF | Missing or partial download | Re-download complete file; Select; Start |
| `Restarting (1)` | Bad model | Logs in admin UI; fix model |
| Client timeout 10060 / ping fails | Different subnet / isolation | Test on server with `127.0.0.1` or same LAN |
| `curl` header errors in PowerShell | Wrong curl | Use `curl.exe` |
