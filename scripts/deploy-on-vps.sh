#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$HOME/shared-agent-vps-runtime}"

cd "$ROOT_DIR"
git fetch --all --prune
git reset --hard origin/main
bash scripts/bootstrap-vps.sh
