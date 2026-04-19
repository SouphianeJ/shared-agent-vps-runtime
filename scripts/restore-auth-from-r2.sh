#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <app_id>" >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib-auth-r2.sh"

APP_ID="$1"
auth_r2_require_app "$APP_ID"
auth_r2_load_env "$ROOT_DIR"
auth_r2_restore "$ROOT_DIR" "$APP_ID"
