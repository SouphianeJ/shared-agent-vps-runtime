#!/usr/bin/env bash
set -euo pipefail

auth_r2_root_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

auth_r2_load_env() {
  local root_dir="${1:-$(auth_r2_root_dir)}"
  if [ -f "$root_dir/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$root_dir/.env"
    set +a
  fi
  if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
    export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  fi
  if [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  fi
  if [ -n "${R2_ENDPOINT:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
    export AWS_DEFAULT_REGION="auto"
  fi
  export AWS_EC2_METADATA_DISABLED="true"
}

auth_r2_require_app() {
  local app="${1:-}"
  if [ -z "$app" ]; then
    echo "Missing app id." >&2
    return 1
  fi
}

auth_r2_bucket_ready() {
  [ -n "${R2_BUCKET:-}" ] && \
    [ -n "${R2_ENDPOINT:-}" ] && \
    [ -n "${R2_ACCESS_KEY_ID:-}" ] && \
    [ -n "${R2_SECRET_ACCESS_KEY:-}" ]
}

auth_r2_env_name_for_app() {
  local app="$1"
  python3 - <<'PY' "$app"
import re
import sys
app = sys.argv[1]
value = re.sub(r'[^A-Za-z0-9]+', '_', app).upper().strip('_')
print(value)
PY
}

auth_r2_object_key_for_app() {
  local app="$1"
  local app_prefix
  app_prefix="$(auth_r2_env_name_for_app "$app")"
  local override_name="${app_prefix}_CODEX_AUTH_OBJECT_KEY"
  local override_value="${!override_name:-}"
  if [ -n "$override_value" ]; then
    printf '%s\n' "$override_value"
    return 0
  fi

  local key_prefix="${R2_CODEX_AUTH_PREFIX:-codex-auth}"
  printf '%s/%s/auth.json\n' "${key_prefix%/}" "$app"
}

auth_r2_runtime_app_dir() {
  local root_dir="$1"
  local app="$2"
  printf '%s/runtime/apps/%s\n' "$root_dir" "$app"
}

auth_r2_runtime_auth_path() {
  local root_dir="$1"
  local app="$2"
  printf '%s/codex-home/auth.json\n' "$(auth_r2_runtime_app_dir "$root_dir" "$app")"
}

auth_r2_restore() {
  local root_dir="$1"
  local app="$2"

  if ! auth_r2_bucket_ready; then
    echo "R2 auth restore skipped for $app: missing R2 configuration." >&2
    return 0
  fi

  if ! command -v aws >/dev/null 2>&1; then
    echo "R2 auth restore skipped for $app: aws CLI not installed." >&2
    return 0
  fi

  local auth_path
  local object_key
  auth_path="$(auth_r2_runtime_auth_path "$root_dir" "$app")"
  object_key="$(auth_r2_object_key_for_app "$app")"

  mkdir -p "$(dirname "$auth_path")"

  if aws s3 cp "s3://$R2_BUCKET/$object_key" "$auth_path" --endpoint-url "$R2_ENDPOINT" >/dev/null; then
    chmod 600 "$auth_path"
    echo "R2 auth restored for $app from s3://$R2_BUCKET/$object_key"
    return 0
  fi

  echo "R2 auth restore skipped for $app: object not found at s3://$R2_BUCKET/$object_key" >&2
  rm -f "$auth_path"
  return 0
}

auth_r2_upload() {
  local root_dir="$1"
  local app="$2"

  if ! auth_r2_bucket_ready; then
    echo "R2 auth upload skipped for $app: missing R2 configuration." >&2
    return 0
  fi

  if ! command -v aws >/dev/null 2>&1; then
    echo "R2 auth upload skipped for $app: aws CLI not installed." >&2
    return 0
  fi

  local auth_path
  local object_key
  auth_path="$(auth_r2_runtime_auth_path "$root_dir" "$app")"
  object_key="$(auth_r2_object_key_for_app "$app")"

  if [ ! -f "$auth_path" ]; then
    echo "R2 auth upload skipped for $app: $auth_path does not exist." >&2
    return 0
  fi

  aws s3 cp "$auth_path" "s3://$R2_BUCKET/$object_key" --endpoint-url "$R2_ENDPOINT" >/dev/null
  echo "R2 auth uploaded for $app to s3://$R2_BUCKET/$object_key"
}
