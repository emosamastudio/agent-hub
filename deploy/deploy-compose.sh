#!/usr/bin/env bash
set -euo pipefail

script_source="${BASH_SOURCE[0]:-$0}"
script_dir="$(cd "$(dirname "$script_source")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

env_file="${AGENT_HUB_ENV_FILE:-/etc/agent-hub/agent-hub.env}"
compose_file="${repo_root}/deploy/docker-compose.production.yml"
port="8788"
skip_image_pull="false"
skip_release_check="false"
allow_warning="false"
release_check_project=""
release_check_output=""
canary_agent=""
canary_payload=""
ready_timeout_seconds="180"

usage() {
  cat <<'USAGE'
Usage: deploy/deploy-compose.sh [options]

Runs the production Docker Compose deployment flow:
  1. preflight checks
  2. docker compose up -d --build
  3. /api/ready wait
  4. container-local release check

Options:
  --env-file <path>                Production env file. Default: /etc/agent-hub/agent-hub.env
  --compose-file <path>            Compose file. Default: deploy/docker-compose.production.yml
  --port <port>                    Host port to wait on. Default: 8788
  --ready-timeout-seconds <n>      Readiness timeout. Default: 180
  --skip-image-pull                Pass through to preflight for preloaded images
  --skip-release-check             Start the service but skip the release gate
  --allow-warning                  Allow release-check warnings during first empty deployment
  --release-check-project <name>   Project filter for ops release-check, for example oph
  --release-check-output <path>    Write release-check JSON to a host-side file
  --canary-agent <name>            Optional canary agent for release-check
  --canary-payload <json>          Optional canary payload JSON
  -h, --help                       Show this help
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
    --ready-timeout-seconds)
      ready_timeout_seconds="${2:?--ready-timeout-seconds requires a value}"
      shift 2
      ;;
    --skip-image-pull)
      skip_image_pull="true"
      shift
      ;;
    --skip-release-check)
      skip_release_check="true"
      shift
      ;;
    --allow-warning)
      allow_warning="true"
      shift
      ;;
    --release-check-project)
      release_check_project="${2:?--release-check-project requires a value}"
      shift 2
      ;;
    --release-check-output)
      release_check_output="${2:?--release-check-output requires a path}"
      shift 2
      ;;
    --canary-agent)
      canary_agent="${2:?--canary-agent requires a value}"
      shift 2
      ;;
    --canary-payload)
      canary_payload="${2:?--canary-payload requires a JSON string}"
      shift 2
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

compose() {
  AGENT_HUB_ENV_FILE="$env_file" docker compose --env-file "$env_file" -f "$compose_file" "$@"
}

shell_quote() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

run_preflight() {
  local preflight_args=(
    --env-file "$env_file"
    --compose-file "$compose_file"
    --port "$port"
  )
  if [[ "$skip_image_pull" == "true" ]]; then
    preflight_args+=(--skip-image-pull)
  fi
  "${script_dir}/preflight-compose.sh" "${preflight_args[@]}"
}

show_agent_hub_logs() {
  local logs_command_label="docker compose logs --tail=100 agent-hub"
  printf 'Showing recent Agent Hub logs with %s\n' "$logs_command_label" >&2
  compose logs --tail=100 agent-hub >&2 || true
}

wait_for_ready() {
  local ready_url="http://127.0.0.1:${port}/api/ready"
  local deadline=$((SECONDS + ready_timeout_seconds))
  printf 'Waiting for Agent Hub readiness at %s\n' "$ready_url"
  while true; do
    if curl -fsS "$ready_url" >/dev/null 2>&1; then
      printf 'Agent Hub is ready: %s\n' "$ready_url"
      return 0
    fi
    if [[ "$SECONDS" -ge "$deadline" ]]; then
      printf 'Timed out waiting for Agent Hub readiness after %s seconds\n' "$ready_timeout_seconds" >&2
      show_agent_hub_logs
      return 1
    fi
    sleep 2
  done
}

build_release_check_command() {
  local args=(ops release-check --skip-observe --execution-limit 5)
  if [[ "$allow_warning" == "true" ]]; then
    args+=(--allow-warning)
  fi
  if [[ -n "$release_check_project" ]]; then
    args+=(--project "$release_check_project")
  fi
  if [[ -n "$canary_agent" ]]; then
    args+=(--canary-agent "$canary_agent")
  fi
  if [[ -n "$canary_payload" ]]; then
    args+=(--canary-payload "$canary_payload")
  fi

  local command_prefix='AGENT_HUB_URL=http://127.0.0.1:8788 AGENT_HUB_API_KEY="${AGENT_HUB_API_KEY:-$AGENT_HUB_DEFAULT_API_KEY}" AGENT_HUB_DASHBOARD_USER="${AGENT_HUB_DASHBOARD_USER:-admin}" AGENT_HUB_DASHBOARD_PASSWORD="$AGENT_HUB_DASHBOARD_PASSWORD" node packages/sdk/dist/cli.js'
  printf '%s' "$command_prefix"
  local arg
  for arg in "${args[@]}"; do
    printf ' '
    shell_quote "$arg"
  done
}

run_release_check() {
  if [[ "$skip_release_check" == "true" ]]; then
    printf 'Skipping release check by request\n'
    return 0
  fi

  local release_command
  release_command="$(build_release_check_command)"
  printf 'Running Agent Hub release check inside the agent-hub container\n'
  if [[ -n "$release_check_output" ]]; then
    mkdir -p "$(dirname "$release_check_output")"
    set +e
    compose exec -T agent-hub sh -lc "$release_command" | tee "$release_check_output"
    local status="${PIPESTATUS[0]}"
    set -e
    chmod 0600 "$release_check_output"
    return "$status"
  else
    compose exec -T agent-hub sh -lc "$release_command"
  fi
}

run_preflight
compose up -d --build
wait_for_ready
compose ps

# Post-deploy verification
if [[ -x "${script_dir}/deploy-verify.sh" ]]; then
  "${script_dir}/deploy-verify.sh" --env-file "$env_file" --port "$port" --check-journal || true
fi

if ! run_release_check; then
  printf 'Agent Hub release check failed after deployment\n' >&2
  show_agent_hub_logs
  exit 1
fi

printf 'Agent Hub Docker Compose deployment completed\n'
