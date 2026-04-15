#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$ROOT_DIR/runtime/apps/vps-personal-codex" \
  "$ROOT_DIR/runtime/apps/weekly-ideator-control-plane"

for app in vps-personal-codex weekly-ideator-control-plane; do
  mkdir -p \
    "$ROOT_DIR/runtime/apps/$app/codex-home" \
    "$ROOT_DIR/runtime/apps/$app/copilot-home" \
    "$ROOT_DIR/runtime/apps/$app/workspaces/chats"
done

docker compose --env-file "$ROOT_DIR/.env" -f "$ROOT_DIR/docker-compose.yml" up -d --build
