#!/usr/bin/env bash
set -euo pipefail

umask 077

RUNTIME_ROOT="${RUNTIME_ROOT:-/runtime}"

mkdir -p "$RUNTIME_ROOT/apps"
chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/apps"

exec "$@"
