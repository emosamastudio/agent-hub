#!/usr/bin/env bash
set -euo pipefail

# deploy-verify.sh — Post-deployment verification for Agent Hub
#
# Run after "docker compose up -d" to confirm the deployment is healthy.
# Fails fast on any check that would have caught today's deployment mistakes.
#
# Usage:
#   deploy/deploy-verify.sh [options]
#
# Options:
#   --env-file <path>       Env file used for deploy. Default: ./deploy/agent-hub.env
#   --port <port>           Hub port. Default: 8788
#   --check-journal         Also check drizzle migration journal (repo-level check)
#   --check-upstream        Also check LLM upstream endpoint reachability
#   -h, --help              Show this help

script_source="${BASH_SOURCE[0]:-$0}"
script_dir="$(cd "$(dirname "$script_source")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

env_file="${AGENT_HUB_ENV_FILE:-${repo_root}/deploy/agent-hub.env}"
port="8788"
check_journal="false"
check_upstream="false"
failures=0
warnings=0

usage() {
  sed -n '2,14p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) env_file="${2:?--env-file requires a path}"; shift 2 ;;
    --port) port="${2:?--port requires a value}"; shift 2 ;;
    --check-journal) check_journal="true"; shift ;;
    --check-upstream) check_upstream="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

ok()    { printf '\033[32mOK\033[0m  %s\n' "$1"; }
warn()  { warnings=$((warnings + 1)); printf '\033[33mWARN\033[0m %s\n' "$1" >&2; }
fail()  { failures=$((failures + 1)); printf '\033[31mFAIL\033[0m %s\n' "$1" >&2; }

base_url="http://127.0.0.1:${port}"

read_env_value() {
  local key="$1"
  [[ -f "$env_file" ]] || return 1
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

# ── 1. Hub liveness ──

check_health() {
  local resp
  if resp="$(curl -fsS "${base_url}/api/ready" 2>&1)"; then
    ok "/api/ready"
  else
    fail "/api/ready not reachable: ${resp}"
    return
  fi

  if echo "$resp" | grep -q '"database":{"status":"ok"}'; then
    ok "database reported healthy"
  else
    fail "database not healthy in /api/ready response"
  fi
}

# ── 2. Scheduler running ──

check_scheduler() {
  local resp
  if ! resp="$(curl -fsS "${base_url}/api/metrics" 2>&1)"; then
    fail "cannot fetch /api/metrics: ${resp}"
    return
  fi

  local running
  running="$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["scheduler"]["running"])' 2>/dev/null || echo '')"
  if [[ "$running" == "True" ]]; then
    ok "scheduler is running"
  else
    fail "scheduler is NOT running"
  fi

  local tick_count
  tick_count="$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["scheduler"]["tick_count"])' 2>/dev/null || echo '0')"
  printf '  scheduler tick count: %s\n' "$tick_count"
}

# ── 3. Required env vars present ──

REQUIRED_ENV_VARS=(
  AGENT_HUB_POSTGRES_PASSWORD
  AGENT_HUB_DASHBOARD_PASSWORD
  AGENT_HUB_DEFAULT_API_KEY
  AGENT_HUB_ANTHROPIC_API_KEY
  AGENT_HUB_ANTHROPIC_ENDPOINT
)

check_env_vars() {
  local key value
  for key in "${REQUIRED_ENV_VARS[@]}"; do
    value="$(read_env_value "$key" 2>/dev/null || true)"
    if [[ -z "$value" ]]; then
      fail "env var missing or empty: ${key}"
    else
      case "$value" in
        replace-me|replace-me-*|agent_hub_dev_key|admin)
          fail "env var still uses development placeholder: ${key}"
          ;;
        *)
          # Mask secrets in output
          if [[ "$key" == *"PASSWORD"* || "$key" == *"API_KEY"* || "$key" == *"KEY"* ]]; then
            ok "env var configured: ${key}"
          else
            ok "env var configured: ${key}=${value}"
          fi
          ;;
      esac
    fi
  done
}

# ── 4. Migration journal consistency (optional, repo-level) ──

check_migration_journal() {
  if [[ "$check_journal" != "true" ]]; then
    return
  fi
  local journal="${repo_root}/apps/server/drizzle/meta/_journal.json"
  if [[ ! -f "$journal" ]]; then
    warn "drizzle journal not found at ${journal}"
    return
  fi
  local missing=0
  for tag in $(jq -r '.entries[].tag' "$journal" 2>/dev/null || true); do
    if [[ ! -f "${repo_root}/apps/server/drizzle/${tag}.sql" ]]; then
      fail "migration file referenced in journal is missing: drizzle/${tag}.sql"
      missing=$((missing + 1))
    fi
  done
  if [[ "$missing" -eq 0 ]]; then
    ok "drizzle migration journal consistent (${journal})"
  fi
}

# ── 5. Upstream LLM endpoint reachability (optional) ──

check_upstream_connectivity() {
  if [[ "$check_upstream" != "true" ]]; then
    return
  fi
  local endpoint
  endpoint="$(read_env_value AGENT_HUB_ANTHROPIC_ENDPOINT 2>/dev/null || true)"
  if [[ -z "$endpoint" ]]; then
    warn "AGENT_HUB_ANTHROPIC_ENDPOINT not set, skipping upstream check"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not found, skipping upstream check"
    return
  fi
  if curl -fsS --connect-timeout 10 --max-time 30 "${endpoint}/health" >/dev/null 2>&1; then
    ok "upstream LLM endpoint reachable: ${endpoint}"
  else
    fail "upstream LLM endpoint NOT reachable: ${endpoint}"
  fi
}

# ── 6. Agent heartbeat freshness ──

check_agent_heartbeats() {
  local resp cutoff now_epoch
  if ! resp="$(curl -fsS "${base_url}/api/metrics" 2>&1)"; then
    fail "cannot fetch agent metrics: ${resp}"
    return
  fi
  local online offline
  online="$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agents_online"])' 2>/dev/null || echo '')"
  offline="$(echo "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agents_offline"])' 2>/dev/null || echo '')"
  printf '  agents online: %s, offline: %s\n' "${online:-?}" "${offline:-?}"
  if [[ -n "$online" && "$online" -gt 0 ]]; then
    ok "agents are online (${online} agents)"
  elif [[ -n "$offline" && "$offline" -gt 0 ]]; then
    warn "${offline} agents are offline — check executor connectivity"
  else
    warn "no agent metrics available (fresh deployment?)"
  fi
}

# ── 7. Proxy endpoint responds ──

check_proxy_endpoint() {
  local http_code
  http_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${base_url}/v1/messages" \
    -H 'x-api-key: verify_proxy_connectivity_test' \
    -H 'content-type: application/json' \
    -d '{"test":true}' 2>/dev/null || echo '000')"
  if [[ "$http_code" == "401" ]]; then
    ok "LLM proxy endpoint responds (401 for invalid token, expected)"
  else
    fail "LLM proxy endpoint returned unexpected status: ${http_code} (expected 401)"
  fi
}

# ── Main ──

check_health
check_scheduler
check_env_vars
check_agent_heartbeats
check_proxy_endpoint
check_migration_journal
check_upstream_connectivity

if [[ "$failures" -gt 0 ]]; then
  printf '\nAgent Hub verification FAILED: %s failure(s), %s warning(s)\n' "$failures" "$warnings"
  exit 1
fi

printf '\nAgent Hub verification PASSED (%s warning(s))\n' "$warnings"
