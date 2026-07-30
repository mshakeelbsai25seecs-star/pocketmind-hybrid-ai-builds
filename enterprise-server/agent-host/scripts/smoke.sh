#!/usr/bin/env bash
# Smoke: health + preloaded provision + list_dir
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8788}"
TOKEN="${AGENT_HOST_TOKEN:?Set AGENT_HOST_TOKEN}"
SERVER_PATH="${SERVER_PATH:-}"

echo "== health =="
curl -fsS "$BASE_URL/v1/agent/health"
echo

if [[ -z "$SERVER_PATH" ]]; then
  SERVER_PATH="$(mktemp -d "${TMPDIR:-/tmp}/pm-agent-host-smoke.XXXXXX")"
  echo "pocketmind smoke" >"$SERVER_PATH/hello.txt"
fi

echo "== provision/preloaded =="
PROV="$(curl -fsS -X POST "$BASE_URL/v1/workspaces/provision/preloaded" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"server_path\":\"$SERVER_PATH\",\"read_only\":false}")"
echo "$PROV"

WID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["workspaceId"])' <<<"$PROV" 2>/dev/null \
  || node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).workspaceId))' <<<"$PROV")"

echo "== tools/list_dir =="
curl -fsS -X POST "$BASE_URL/v1/agent/tools/list_dir" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"workspace_id\":\"$WID\",\"path\":\".\"}"
echo
echo "OK workspaceId=$WID"
