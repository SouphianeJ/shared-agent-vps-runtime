#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <legacy_root> <runtime_root>" >&2
  exit 1
fi

LEGACY_ROOT="$1"
RUNTIME_ROOT="$2"

for app in vps-personal-codex weekly-ideator-control-plane; do
  mkdir -p \
    "$RUNTIME_ROOT/runtime/apps/$app/codex-home" \
    "$RUNTIME_ROOT/runtime/apps/$app/copilot-home" \
    "$RUNTIME_ROOT/runtime/apps/$app/workspaces"

  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$LEGACY_ROOT/.codex-vps/state/" "$RUNTIME_ROOT/runtime/apps/$app/codex-home/"
    rsync -a "$LEGACY_ROOT/.copilot-vps/state/" "$RUNTIME_ROOT/runtime/apps/$app/copilot-home/"
    rsync -a "$LEGACY_ROOT/.codex-vps/workspace/" "$RUNTIME_ROOT/runtime/apps/$app/workspaces/"
  else
    cp -a "$LEGACY_ROOT/.codex-vps/state/." "$RUNTIME_ROOT/runtime/apps/$app/codex-home/"
    cp -a "$LEGACY_ROOT/.copilot-vps/state/." "$RUNTIME_ROOT/runtime/apps/$app/copilot-home/"
    cp -a "$LEGACY_ROOT/.codex-vps/workspace/." "$RUNTIME_ROOT/runtime/apps/$app/workspaces/"
  fi
done
