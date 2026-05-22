# Agent Hub Deployment Runbook

This runbook targets a personal or small-team internal deployment. The server is the stable API surface for projects such as OPH; the dashboard is optional and can remain a read-mostly operator view.

## Production Defaults

- `NODE_ENV=production` disables default project/demo seeding unless explicitly enabled.
- Production startup fails fast unless `DATABASE_URL`, `AGENT_HUB_DASHBOARD_PASSWORD`, and `AGENT_HUB_DEFAULT_API_KEY` are explicit non-development values.
- `/api/health` and `/api/ready` are unauthenticated and include PostgreSQL readiness.
- `SIGTERM` and `SIGINT` stop the scheduler, close Fastify, and close the PostgreSQL pool.
- Project API keys should be created per consumer project. Do not share the development key.

## Build

```bash
npm ci
npm run build
set -a
. /etc/agent-hub/agent-hub.env
set +a
npm run db:migrate -w @agent-hub/server
```

## Docker Compose

Use Docker Compose on hosts where the system Node runtime is missing or too old
for Agent Hub. This is the preferred deployment path for `emoworklaptop`, which
currently has Docker available but only an obsolete system Node.

Install the env file. The installer generates production random values for
`AGENT_HUB_POSTGRES_PASSWORD`, `AGENT_HUB_DASHBOARD_PASSWORD`, and
`AGENT_HUB_DEFAULT_API_KEY` without printing secret values:

```bash
sudo deploy/install-compose-env.sh --env-file /etc/agent-hub/agent-hub.env
```

For the Compose deployment, `DATABASE_URL` is injected as
`postgres://agent_hub:<AGENT_HUB_POSTGRES_PASSWORD>@postgres:5432/agent_hub` by
`deploy/docker-compose.production.yml`; the local value in the env file is only
used by non-containerized commands.

Deploy, wait for readiness, and run the fast release gate:

```bash
deploy/deploy-compose.sh \
  --env-file /etc/agent-hub/agent-hub.env \
  --release-check-project oph \
  --release-check-output /var/log/agent-hub/release-check-oph.json
```

Use `deploy/preflight-compose.sh` directly when you want a read-only host check
before changing anything. Use raw `docker compose` commands only for debugging
or explicit manual rollout control.

Verify:

```bash
docker compose --env-file /etc/agent-hub/agent-hub.env -f deploy/docker-compose.production.yml ps
docker compose --env-file /etc/agent-hub/agent-hub.env -f deploy/docker-compose.production.yml logs --tail=100 agent-hub
curl -fsS http://127.0.0.1:8788/api/ready
```

Stop or restart:

```bash
docker compose --env-file /etc/agent-hub/agent-hub.env -f deploy/docker-compose.production.yml restart agent-hub
docker compose --env-file /etc/agent-hub/agent-hub.env -f deploy/docker-compose.production.yml down
```

### emoworklaptop Target

Current target facts from read-only preflight:

- Connect through `ssh emoworklaptop_jump`; direct LAN/Tailscale SSH can be
  unavailable from the development machine.
- OS is Ubuntu 22.04.
- Docker is installed.
- System Node is v12 and should not be used for Agent Hub.
- `/opt/agent-hub`, `~/workspace/agent-hub`, and `/etc/agent-hub/agent-hub.env`
  were not present during preflight.
- Port `8788` was not occupied during preflight.

First deploy outline:

```bash
ssh emoworklaptop_jump
git clone https://github.com/emosamastudio/agent-hub.git ~/workspace/agent-hub
cd ~/workspace/agent-hub
sudo deploy/install-compose-env.sh --env-file /etc/agent-hub/agent-hub.env
deploy/deploy-compose.sh --env-file /etc/agent-hub/agent-hub.env --release-check-project oph --release-check-output /var/log/agent-hub/release-check-oph.json
curl -fsS http://127.0.0.1:8788/api/ready
```

If Docker Hub access fails while pulling `node:22-bookworm-slim` or
`postgres:16-alpine`, configure Docker daemon proxy on `emoworklaptop` or load
prebuilt images before running Compose. Use
`deploy/preflight-compose.sh --skip-image-pull` or
`deploy/deploy-compose.sh --skip-image-pull` only when the required images are
already present or will be loaded out of band.

## Environment

Install the production env file. For Docker Compose, prefer the installer:

```bash
sudo deploy/install-compose-env.sh --env-file /etc/agent-hub/agent-hub.env
```

For non-containerized systemd deployments, install and edit the example under
the `agent-hub` service account:

```bash
sudo install -d -m 0750 -o agent-hub -g agent-hub /etc/agent-hub
sudo install -m 0640 -o agent-hub -g agent-hub deploy/agent-hub.env.example /etc/agent-hub/agent-hub.env
sudo editor /etc/agent-hub/agent-hub.env
```

Required edits:

- Set `DATABASE_URL` to the production PostgreSQL database.
- Replace `AGENT_HUB_DASHBOARD_PASSWORD`.
- Replace `AGENT_HUB_DEFAULT_API_KEY` or avoid using default-project API access entirely.
- Keep `AGENT_HUB_BOOTSTRAP_DEFAULT_PROJECT=false` and `AGENT_HUB_SEED_DEMO_AGENT=false` unless doing a one-time migration from a dev-style install.

## systemd

Assuming the built repo is deployed at `/opt/agent-hub` and Node is available at `/usr/bin/node`:

```bash
sudo useradd --system --home /var/lib/agent-hub --shell /usr/sbin/nologin agent-hub
sudo install -d -m 0750 -o agent-hub -g agent-hub /var/lib/agent-hub /var/log/agent-hub
sudo install -m 0644 deploy/systemd/agent-hub.service /etc/systemd/system/agent-hub.service
sudo systemctl daemon-reload
sudo systemctl enable --now agent-hub
```

Verify:

```bash
curl -fsS http://127.0.0.1:8788/api/ready
curl -fsS http://127.0.0.1:8788/api/metrics
node packages/sdk/dist/cli.js ready
node packages/sdk/dist/cli.js metrics
systemctl status agent-hub
journalctl -u agent-hub -n 100 --no-pager
```

## Observability And 24h Canary

Agent Hub emits Fastify/Pino request logs and structured scheduler lifecycle logs to stdout/stderr. Under systemd, read them from journald:

```bash
journalctl -u agent-hub -f --output=cat
```

Scheduler logs include stable fields:

- `component=scheduler`
- `event=scheduler.started`
- `event=scheduler.stopped`
- `event=scheduler.warning`
- `event=scheduler.tick.skipped`
- `event=scheduler.step.failed`
- `event=scheduler.tick.failed`
- `event=scheduler.advisory_unlock.failed`

The unauthenticated metrics snapshot is intended for local health checks and canary observation:

```bash
node packages/sdk/dist/cli.js metrics
curl -fsS http://127.0.0.1:8788/api/metrics | jq
```

During the first 24 hours after deployment, check at least these fields every hour and after each OPH canary:

- `scheduler.running` remains `true`.
- `scheduler.tick_count` keeps increasing.
- `scheduler.last_tick_error_count` remains `0`; if not, inspect `scheduler.last_tick_step_errors` and journald events.
- `executions_queued` does not grow without matching executor activity.
- `executions_failed` and `executions_timeout` do not increase unexpectedly.
- `alerts_active` does not grow or stay unacknowledged after triage.
- `agents_enabled`, `agents_online`, and `agents_offline` match the expected OPH executor rollout state.

Useful operator loop:

```bash
node packages/sdk/dist/cli.js ops observe --project oph --iterations 24 --interval-ms 3600000 --strict --fail-on-warning --execution-limit 5
node packages/sdk/dist/cli.js ops status --project oph --strict --fail-on-warning --execution-limit 5
node packages/sdk/dist/cli.js doctor --project oph
node packages/sdk/dist/cli.js scheduler status --project oph
node packages/sdk/dist/cli.js agents list --project oph
node packages/sdk/dist/cli.js executors list --project oph
node packages/sdk/dist/cli.js executions list --project oph --status queued --limit 20
node packages/sdk/dist/cli.js executions list --project oph --status running --limit 20
node packages/sdk/dist/cli.js executions inspect <failed-or-timeout-execution-id>
node packages/sdk/dist/cli.js alerts list --limit 20
```

Treat any `scheduler.step.failed`, `scheduler.tick.failed`, growing queued backlog, or repeated timeout/failed executions as a canary failure until explained.

Project-level stop switch:

```bash
node packages/sdk/dist/cli.js projects drain oph
node packages/sdk/dist/cli.js projects drain oph --cancel-running
node packages/sdk/dist/cli.js projects enable oph
```

The first command disables OPH agents and cancels queued work while allowing already running executions to finish. Use `--cancel-running` only when the running work itself must be interrupted.
After maintenance, run `projects enable oph` to re-enable scheduling for the OPH agents.

## OPH Project Setup

Create or verify the OPH project through the CLI. Run this from the built Agent Hub checkout or any environment where `agent-hub` is installed.

```bash
AGENT_HUB_URL=http://127.0.0.1:8788 \
AGENT_HUB_DASHBOARD_USER=admin \
AGENT_HUB_DASHBOARD_PASSWORD=<dashboard-password> \
node packages/sdk/dist/cli.js projects ensure oph \
  --display-name "Open Source Project Hunter" \
  --description "OPH executor integration"
```

If the project is created, the CLI prints a one-time plaintext `api_key`. Store it in OPH deployment secrets:

```bash
AGENT_HUB_URL=http://<agent-hub-host>:8788
AGENT_HUB_PROJECT=oph
AGENT_HUB_API_KEY=<oph-project-key>
```

If the project already exists and the plaintext key is lost, rotate it:

```bash
node packages/sdk/dist/cli.js projects rotate-key oph
```

Generate MCP config for coding agents that should operate Agent Hub directly:

```bash
node packages/sdk/dist/cli.js mcp config \
  --name agent-hub-oph \
  --node-entry packages/sdk/dist/mcp.js \
  --url "$AGENT_HUB_URL" \
  --api-key "$AGENT_HUB_API_KEY" \
  --dashboard-user "$AGENT_HUB_DASHBOARD_USER" \
  --dashboard-password "$AGENT_HUB_DASHBOARD_PASSWORD"
```

## Smoke Test

After OPH registers its executor agents:

```bash
node packages/sdk/dist/cli.js doctor --project oph
node packages/sdk/dist/cli.js ops status --project oph --strict --fail-on-warning --execution-limit 5
node packages/sdk/dist/cli.js ops observe --project oph --iterations 2 --interval-ms 300000 --strict --fail-on-warning --execution-limit 5
node packages/sdk/dist/cli.js metrics
node packages/sdk/dist/cli.js scheduler status --project oph
node packages/sdk/dist/cli.js agents list --project oph
node packages/sdk/dist/cli.js agents get enrich_repo --project oph
node packages/sdk/dist/cli.js canary run enrich_repo \
  --project oph \
  --payload '{"repo_name":"agent-hub-smoke"}' \
  --timeout-ms 600000
```

Use a low-risk OPH handler for first smoke. Run `deep_research` only during the formal canary because it can invoke sidecars/LLMs and write research artifacts.

## Backup And Upgrade

Before touching the running service, generate the agent-readable recovery plan:

```bash
node packages/sdk/dist/cli.js ops recovery-plan \
  --project oph \
  --backup-dir /var/backups/agent-hub \
  --service-name agent-hub \
  --env-file /etc/agent-hub/agent-hub.env
```

Before the first production upgrade, and periodically after that, rehearse the
restore flow against a disposable database. `AGENT_HUB_RESTORE_DATABASE_URL`
must point at an empty throwaway database, never at production:

```bash
node packages/sdk/dist/cli.js ops recovery-drill-plan \
  --project oph \
  --backup-dir /var/backups/agent-hub \
  --env-file /etc/agent-hub/agent-hub.env
```

Run the generated commands in order. The drill verifies that `pg_dump`, restore,
migration replay, and core table integrity checks work before a real incident
requires them.

To let the CLI execute the same drill and stop on the first failed command:

```bash
node packages/sdk/dist/cli.js ops recovery-drill run \
  --project oph \
  --backup-dir /var/backups/agent-hub \
  --env-file /etc/agent-hub/agent-hub.env \
  --yes-reset-restore-db
```

The `--yes-reset-restore-db` flag is intentionally required because the command
drops and recreates the restore database schema. Only use it after confirming
`AGENT_HUB_RESTORE_DATABASE_URL` points at the disposable restore database.

For a single release gate that a coding agent or rollout script can run before
and after deployment:

```bash
node packages/sdk/dist/cli.js ops release-check \
  --project oph \
  --canary-agent enrich_repo \
  --observe-iterations 2 \
  --observe-interval-ms 300000 \
  --output-file /var/log/agent-hub/release-check-oph.json
```

When the disposable restore database is configured, include the recovery drill
in the same gate:

```bash
node packages/sdk/dist/cli.js ops release-check \
  --project oph \
  --include-recovery-drill \
  --yes-reset-restore-db \
  --canary-agent enrich_repo \
  --observe-iterations 2 \
  --observe-interval-ms 300000 \
  --output-file /var/log/agent-hub/release-check-oph.json
```

Before an upgrade:

```bash
pg_dump "$DATABASE_URL" > "agent_hub_$(date +%F_%H%M%S).sql"
sudo systemctl stop agent-hub
```

Deploy the new build, then:

```bash
set -a
. /etc/agent-hub/agent-hub.env
set +a
npm run db:migrate -w @agent-hub/server
sudo systemctl start agent-hub
curl -fsS http://127.0.0.1:8788/api/ready
```

Rollback is release-directory rollback plus database restore when a failed migration is not backward compatible. Use the `rollback.commands` and `verify.commands` returned by `ops recovery-plan` so the exact backup path and post-restore checks are captured in the incident or release notes.
