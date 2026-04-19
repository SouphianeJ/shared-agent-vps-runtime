#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib-auth-r2.sh"

auth_r2_load_env "$ROOT_DIR"

mapfile -t APPS < <(
  python3 - <<'PY' "$ROOT_DIR/config/apps.json"
import json
import sys
from pathlib import Path

config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for app in config.get("apps", []):
    app_id = str(app.get("id", "")).strip()
    if app_id:
        print(app_id)
PY
)

for app in "${APPS[@]}"; do
  mkdir -p \
    "$ROOT_DIR/runtime/apps/$app/codex-home" \
    "$ROOT_DIR/runtime/apps/$app/copilot-home" \
    "$ROOT_DIR/runtime/apps/$app/workspaces/chats"
  ln -sfn "$ROOT_DIR/runtime/apps/$app/codex-home" "$ROOT_DIR/runtime/apps/$app/.codex"
  ln -sfn "$ROOT_DIR/runtime/apps/$app/copilot-home" "$ROOT_DIR/runtime/apps/$app/.copilot"
  auth_r2_restore "$ROOT_DIR" "$app"
done

docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/docker-compose.yml" up -d --build
