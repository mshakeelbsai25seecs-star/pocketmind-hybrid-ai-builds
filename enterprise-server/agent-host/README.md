# PocketCode Agent Host

Standalone Axum service for remote PocketCode workspace tools and provisioning.
Separate from the Full RAG gateway.

## Requirements

- Rust 1.75+ (edition 2021)
- Optional: `git` on PATH for git provision
- Optional: `python` / `node` on PATH for sandbox runners

## Environment

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENT_HOST_TOKEN` | yes | — | Bearer token for all protected routes |
| `AGENT_HOST_BIND` | no | `0.0.0.0:8788` | Listen address |
| `AGENT_HOST_DATA` | no | `/var/lib/nexusai` (Linux) / `D:/nexusai-agent-host` (Windows) | Data root |

On-disk layout:

```text
{AGENT_HOST_DATA}/
  workspaces/{id}/     # synced / git / empty trees
  meta/{id}.json       # id, root_path, provision, read_only, created_at
  uploads/{upload_id}/ # chunked sync assembly
```

## Run

From the repo root:

```bash
export AGENT_HOST_TOKEN='dev-token-change-me'
export AGENT_HOST_DATA="$HOME/nexusai-agent-host"   # or D:/nexusai-agent-host on Windows
cargo run -p pocketcode-agent-host
```

PowerShell:

```powershell
$env:AGENT_HOST_TOKEN = 'dev-token-change-me'
$env:AGENT_HOST_DATA = 'D:\nexusai-agent-host'
cargo run -p pocketcode-agent-host
```

## Smoke tests

```bash
# Unix
./enterprise-server/agent-host/scripts/smoke.sh

# Windows
pwsh ./enterprise-server/agent-host/scripts/smoke.ps1
```

## Curl examples

Health (no auth):

```bash
curl -s http://127.0.0.1:8788/v1/agent/health
```

Create empty workspace:

```bash
curl -s -X POST http://127.0.0.1:8788/v1/workspaces \
  -H "Authorization: Bearer $AGENT_HOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Preloaded provision (bind an existing server directory):

```bash
curl -s -X POST http://127.0.0.1:8788/v1/workspaces/provision/preloaded \
  -H "Authorization: Bearer $AGENT_HOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"server_path\":\"/path/to/project\",\"read_only\":false}"
```

List directory tool:

```bash
curl -s -X POST http://127.0.0.1:8788/v1/agent/tools/list_dir \
  -H "Authorization: Bearer $AGENT_HOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"YOUR_ID\",\"path\":\".\"}"
```

Provision result shape (camelCase):

```json
{ "workspaceId": "...", "rootPath": "...", "message": "..." }
```

Errors:

```json
{ "error": "..." }
```

## Client wiring

Desktop TypeScript adapters:

- Tools: `src/codeWorkspace/transports/remoteAgentHttp.ts`
- Provision: `src/codeWorkspace/provisioning/*`

Point the runtime profile `remote.baseUrl` at this service (e.g. `http://server:8788`).
Use the same org Bearer token as `AGENT_HOST_TOKEN` (or a shared enterprise token mapped by ops).
