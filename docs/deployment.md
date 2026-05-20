# Agent Hub Deployment Runbook

This runbook targets a personal or small-team internal deployment. The server is the stable API surface for projects such as OPH; the dashboard is optional and can remain a read-mostly operator view.

## Production Defaults

- `NODE_ENV=production` disables default project/demo seeding unless explicitly enabled.
- `/api/health` and `/api/ready` are unauthenticated and include PostgreSQL readiness.
- `SIGTERM` and `SIGINT` stop the scheduler, close Fastify, and close the PostgreSQL pool.
- Project API keys should be created per consumer project. Do not share the development key.

## Build

```bash
npm ci
npm run build
npm run db:migrate -w @agent-hub/server
```

## Environment

Install the production env file from `deploy/agent-hub.env.example`:

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
systemctl status agent-hub
journalctl -u agent-hub -n 100 --no-pager
```

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
node packages/sdk/dist/cli.js projects rotate-key <oph-project-id>
```

## Smoke Test

After OPH registers its executor agents:

```bash
node packages/sdk/dist/cli.js scheduler status
node packages/sdk/dist/cli.js agents list
node packages/sdk/dist/cli.js trigger enrich_repo \
  --payload '{"repo_name":"agent-hub-smoke"}' \
  --dedup-policy allow_duplicate
node packages/sdk/dist/cli.js executions list --limit 5
```

Use a low-risk OPH handler for first smoke. Run `deep_research` only during the formal canary because it can invoke sidecars/LLMs and write research artifacts.

## Backup And Upgrade

Before an upgrade:

```bash
pg_dump "$DATABASE_URL" > "agent_hub_$(date +%F_%H%M%S).sql"
sudo systemctl stop agent-hub
```

Deploy the new build, then:

```bash
npm run db:migrate -w @agent-hub/server
sudo systemctl start agent-hub
curl -fsS http://127.0.0.1:8788/api/ready
```

Rollback is release-directory rollback plus database restore when a failed migration is not backward compatible.
