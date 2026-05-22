#!/usr/bin/env bash
set -euo pipefail

script_source="${BASH_SOURCE[0]:-$0}"
script_dir="$(cd "$(dirname "$script_source")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

env_file="${AGENT_HUB_ENV_FILE:-/etc/agent-hub/agent-hub.env}"
compose_file="${repo_root}/deploy/docker-compose.production.yml"
port="8788"
skip_image_pull="false"
required_free_kb="5242880"
failures=0
warnings=0

usage() {
  cat <<'USAGE'
Usage: deploy/preflight-compose.sh [options]

Checks whether a host is ready to run Agent Hub through Docker Compose.
The script does not start, stop, or modify services.

Options:
  --env-file <path>       Production env file. Default: /etc/agent-hub/agent-hub.env
  --compose-file <path>   Compose file. Default: deploy/docker-compose.production.yml
  --port <port>           Host port to check. Default: 8788
  --skip-image-pull       Skip pulling node:22-bookworm-slim and postgres:16-alpine
  -h, --help              Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      env_file="${2:?--env-file requires a path}"
      shift 2
      ;;
    --compose-file)
      compose_file="${2:?--compose-file requires a path}"
      shift 2
      ;;
    --port)
      port="${2:?--port requires a value}"
      shift 2
      ;;
    --skip-image-pull)
      skip_image_pull="true"
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

ok() {
  printf 'OK: %s\n' "$1"
}

warn() {
  warnings=$((warnings + 1))
  printf 'WARN: %s\n' "$1" >&2
}

fail() {
  failures=$((failures + 1))
  printf 'FAIL: %s\n' "$1" >&2
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

read_env_value() {
  local key="$1"
  awk -v key="$key" '
    BEGIN { FS = "=" }
    $1 == key {
      sub(/^[^=]*=/, "")
      gsub(/^"|"$/, "")
      gsub(/^'\''|'\''$/, "")
      print
      exit
    }
  ' "$env_file"
}

require_secret() {
  local key="$1"
  local value
  value="$(read_env_value "$key" || true)"
  if [[ -z "$value" ]]; then
    fail "${key} is missing or empty in ${env_file}"
    return
  fi
  case "$value" in
    replace-me|replace-me-*|*replace-me*|agent_hub_dev_key|admin)
      fail "${key} still uses a development placeholder"
      ;;
    *)
      ok "${key} is configured"
      ;;
  esac
}

port_is_listening() {
  if have_command ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"
    return $?
  fi
  if have_command lsof; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

check_file() {
  local path="$1"
  local label="$2"
  if [[ -f "$path" ]]; then
    ok "${label} exists: ${path}"
  else
    fail "${label} is missing: ${path}"
  fi
}

check_docker() {
  if ! have_command docker; then
    fail "docker command is not installed"
    return
  fi
  ok "docker command is installed"

  if docker info >/dev/null 2>&1; then
    ok "Docker daemon is reachable"
  else
    fail "Docker daemon is not reachable"
  fi

  if docker compose version >/dev/null 2>&1; then
    ok "docker compose plugin is available"
  else
    fail "docker compose plugin is not available"
  fi
}

check_disk() {
  local available_kb
  available_kb="$(df -Pk "$repo_root" | awk 'NR == 2 {print $4}')"
  if [[ -n "$available_kb" && "$available_kb" -ge "$required_free_kb" ]]; then
    ok "at least 5 GiB disk space is available"
  else
    fail "less than 5 GiB disk space is available"
  fi
}

check_compose_config() {
  if [[ ! -f "$env_file" || ! -f "$compose_file" || ! "$(command -v docker || true)" ]]; then
    return
  fi
  if AGENT_HUB_ENV_FILE="$env_file" docker compose --env-file "$env_file" -f "$compose_file" config >/dev/null; then
    ok "Docker Compose production config is valid"
  else
    fail "Docker Compose production config is invalid"
  fi
}

check_images() {
  if [[ "$skip_image_pull" == "true" ]]; then
    warn "skipping Docker image pull checks"
    return
  fi
  if ! have_command docker; then
    return
  fi
  local image
  for image in node:22-bookworm-slim postgres:16-alpine; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      ok "Docker image is already present: ${image}"
    elif docker pull "$image" >/dev/null; then
      ok "Docker image can be pulled: ${image}"
    else
      fail "Docker image cannot be pulled: ${image}"
    fi
  done
}

check_port() {
  if have_command curl && curl -fsS "http://127.0.0.1:${port}/api/ready" >/dev/null 2>&1; then
    warn "port ${port} is already serving a healthy Agent Hub instance"
    return
  fi
  if port_is_listening; then
    fail "port ${port} is already in use and does not serve Agent Hub /api/ready"
  else
    ok "port ${port} is available"
  fi
}

check_file "$env_file" "env file"
check_file "$compose_file" "compose file"

if [[ -f "$env_file" ]]; then
  require_secret AGENT_HUB_POSTGRES_PASSWORD
  require_secret AGENT_HUB_DASHBOARD_PASSWORD
  require_secret AGENT_HUB_DEFAULT_API_KEY
fi

check_docker
check_disk
check_compose_config
check_port
check_images

if [[ "$failures" -gt 0 ]]; then
  printf 'Agent Hub Compose preflight failed: %s failure(s), %s warning(s)\n' "$failures" "$warnings" >&2
  exit 1
fi

printf 'Agent Hub Compose preflight passed: %s warning(s)\n' "$warnings"
