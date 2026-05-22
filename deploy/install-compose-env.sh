#!/usr/bin/env bash
set -euo pipefail

script_source="${BASH_SOURCE[0]:-$0}"
script_dir="$(cd "$(dirname "$script_source")" && pwd)"

env_file="${AGENT_HUB_ENV_FILE:-/etc/agent-hub/agent-hub.env}"
example_file="${script_dir}/agent-hub.env.example"
force="false"

usage() {
  cat <<'USAGE'
Usage: deploy/install-compose-env.sh [options]

Installs a production Agent Hub env file for Docker Compose.
The script generates non-development secrets and does not print secret values.

Options:
  --env-file <path>      Target env file. Default: /etc/agent-hub/agent-hub.env
  --example-file <path>  Source env example. Default: deploy/agent-hub.env.example
  --force                Replace an existing env file
  -h, --help             Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      env_file="${2:?--env-file requires a path}"
      shift 2
      ;;
    --example-file)
      example_file="${2:?--example-file requires a path}"
      shift 2
      ;;
    --force)
      force="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64
  printf '\n'
}

replace_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[&/\]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s/^${key}=.*/${key}=${escaped}/" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
  rm -f "${file}.bak"
}

if [[ ! -f "$example_file" ]]; then
  printf 'Example env file is missing: %s\n' "$example_file" >&2
  exit 1
fi

if [[ -f "$env_file" && "$force" != "true" ]]; then
  printf 'Agent Hub env file already exists: %s\n' "$env_file"
  printf 'Leaving it unchanged. Use --force to replace it.\n'
  exit 0
fi

target_dir="$(dirname "$env_file")"
mkdir -p "$target_dir"
chmod 0750 "$target_dir"

tmp_file="$(mktemp "${env_file}.tmp.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT
cp "$example_file" "$tmp_file"

postgres_password="$(generate_secret)"
dashboard_password="$(generate_secret)"
default_api_key="$(generate_secret)"

replace_env_value "$tmp_file" AGENT_HUB_POSTGRES_PASSWORD "$postgres_password"
replace_env_value "$tmp_file" DATABASE_URL "postgres://agent_hub:${postgres_password}@127.0.0.1:5432/agent_hub"
replace_env_value "$tmp_file" AGENT_HUB_DASHBOARD_PASSWORD "$dashboard_password"
replace_env_value "$tmp_file" AGENT_HUB_DEFAULT_API_KEY "$default_api_key"
sed -i.bak 's/replace-me/set-disposable-restore-secret-before-use/g' "$tmp_file"
rm -f "${tmp_file}.bak"

install -m 0640 "$tmp_file" "$env_file"
chmod 0640 "$env_file"

printf 'Installed Agent Hub env file: %s\n' "$env_file"
printf 'Configured production values for AGENT_HUB_POSTGRES_PASSWORD, AGENT_HUB_DASHBOARD_PASSWORD, and AGENT_HUB_DEFAULT_API_KEY.\n'
printf 'Secret values were not printed. Store or inspect them through your host secret-management process.\n'
