# Agent Hub

Independent local-first Agent Cron / Job control plane for scheduling, dispatching, monitoring, and tracing AI agent tasks across projects.

Agent Hub is the platform. Business repositories are consumers: they register agents through the SDK/API, poll for work, execute in their own codebases, and report results back.

## Workspace layout

- `apps/server`: Fastify + PostgreSQL + Drizzle control plane
- `apps/web`: React + Vite dashboard
- `packages/sdk`: TypeScript SDK for Node.js executors
- `packages/shared`: shared platform API contracts
- `sdks/go/agenthub`: Go SDK for executor workers in Go projects

## Run locally

```bash
npm install
docker compose up -d
npm run db:migrate -w @agent-hub/server
npm run dev
```

In production, `db:migrate` requires an explicit `DATABASE_URL` and refuses the local development database fallback.

Default local endpoints:

- Dashboard: `http://127.0.0.1:5174`
- Server: `http://127.0.0.1:8788`
- Health: `http://127.0.0.1:8788/api/health`
- Readiness: `http://127.0.0.1:8788/api/ready`

Default development credentials:

- Dashboard Basic Auth: username/password default to `admin` / `admin` in local dev. If changed, set both server env (`AGENT_HUB_DASHBOARD_USER`, `AGENT_HUB_DASHBOARD_PASSWORD`) and dashboard env (`VITE_AGENT_HUB_DASHBOARD_USER`, `VITE_AGENT_HUB_DASHBOARD_PASSWORD`).
- SDK/API key: `agent_hub_dev_key`

Override these in `.env` before exposing the server beyond localhost.

For an internal stable deployment, use the production runbook in [`docs/deployment.md`](docs/deployment.md). Production mode does not seed the default project or demo agent unless `AGENT_HUB_BOOTSTRAP_DEFAULT_PROJECT=true` is set explicitly, and the server refuses to start with development database/auth/API-key defaults.

## Core model

Agent Hub owns:

- projects and API keys
- agent registry
- cron/manual/API trigger creation
- queued/running/terminal execution state
- executor polling and atomic claim
- concurrency accounting
- idempotency dedupe by agent/key
- retries and retention cleanup
- trace collection
- dashboard views for agent lifecycle control, execution control, traces, and alerts

Agent Hub does not own business execution logic. Executors run in their consumer project and communicate through API/SDK boundaries.

## Environment

```bash
DATABASE_URL=postgres://agent_hub:agent_hub_dev@localhost:5433/agent_hub
AGENT_HUB_HOST=127.0.0.1
AGENT_HUB_PORT=8788
AGENT_HUB_WEB_PORT=5174
AGENT_HUB_DASHBOARD_USER=admin
AGENT_HUB_DASHBOARD_PASSWORD=admin
VITE_AGENT_HUB_DASHBOARD_USER=admin
VITE_AGENT_HUB_DASHBOARD_PASSWORD=admin
AGENT_HUB_DEFAULT_API_KEY=agent_hub_dev_key
AGENT_HUB_BOOTSTRAP_DEFAULT_PROJECT=true
AGENT_HUB_SEED_DEMO_AGENT=true
AGENT_HUB_SCHEDULER_TICK_MS=1000
AGENT_HUB_EXECUTION_RETENTION_DAYS=90
AGENT_HUB_TRACE_RETENTION_DAYS=30
AGENT_HUB_ALERT_RETENTION_DAYS=180
AGENT_HUB_MAX_TRIGGER_DEPTH=5
```

## Minimal API flow

Register an agent:

```bash
curl -X PUT http://127.0.0.1:8788/api/registry/agents \
  -H "authorization: Bearer agent_hub_dev_key" \
  -H "Agent-Hub-Version: 1" \
  -H "content-type: application/json" \
  -d '{
    "name": "demo_agent",
    "displayName": "Demo Agent",
    "description": "Runs a small demo task to validate Agent Hub scheduling and reporting.",
    "agentType": "cron_task",
    "handler": "demo_handler",
    "cron": "*/5 * * * *",
    "concurrency": 1
  }'
```

Trigger work:

```bash
curl -X POST http://127.0.0.1:8788/api/agents/demo_agent/trigger \
  -H "authorization: Bearer agent_hub_dev_key" \
  -H "Agent-Hub-Version: 1" \
  -H "content-type: application/json" \
  -d '{
    "payload": { "demo": true },
    "idempotency_key": "demo:once",
    "dedup_policy": "skip_if_running"
  }'
```

Executor heartbeat and poll:

```bash
curl -X POST http://127.0.0.1:8788/api/executors/heartbeat \
  -H "authorization: Bearer agent_hub_dev_key" \
  -H "Agent-Hub-Version: 1" \
  -H "content-type: application/json" \
  -d '{ "agent_names": ["demo_agent"] }'

curl "http://127.0.0.1:8788/api/executors/poll?agent_names=demo_agent" \
  -H "authorization: Bearer agent_hub_dev_key" \
  -H "Agent-Hub-Version: 1"
```

Report completion:

```bash
curl -X POST http://127.0.0.1:8788/api/executions/<execution-id>/report \
  -H "authorization: Bearer agent_hub_dev_key" \
  -H "Agent-Hub-Version: 1" \
  -H "content-type: application/json" \
  -d '{ "status": "success", "result_summary": "done" }'
```

## TypeScript SDK

```ts
import { AgentHubClient } from "@agent-hub/sdk";

const hub = new AgentHubClient({
  serverUrl: "http://127.0.0.1:8788",
  project: "default",
  apiKey: "agent_hub_dev_key",
});

hub.register({
  name: "demo_agent",
  displayName: "Demo Agent",
  description: "Runs a small demo task to validate Agent Hub scheduling and reporting.",
  agentType: "cron_task",
  cron: "*/5 * * * *",
  handler: "demo_handler",
});

hub.handle("demo_agent", async (ctx) => {
  return { received: ctx.payload };
});

await hub.start();
```

Executor registry sync is fail-fast: `syncRegistry()` and `start()` verify that
each registered agent has a local handler before exposing it to Agent Hub for
scheduling.

For deterministic tests or one-shot workers, call `await hub.runOnce()` to poll and execute at most one queued execution.

## Go SDK

The Go SDK is intended for Go services that run real executor workers in their
own repository. It wraps registry sync, heartbeat/progress, poll, and final
execution reporting.

Production consumers should pin the tagged nested module:

```go
require github.com/emosamastudio/agent-hub/sdks/go/agenthub v0.3.0
```

```go
package main

import (
	"context"

	agenthub "github.com/emosamastudio/agent-hub/sdks/go/agenthub"
)

func main() {
	client := agenthub.NewClient(agenthub.Config{
		ServerURL: "http://127.0.0.1:8788",
		Project:   "default",
		APIKey:    "agent_hub_dev_key",
	})

	client.Register(agenthub.AgentSpec{
		Name:        "demo_go_worker",
		DisplayName: "Demo Go Worker",
		Description: "Runs a Go demo worker to validate registry sync, polling, progress, and reporting.",
		AgentType:   agenthub.AgentTypeCronTask,
		Handler:     "demo_go_handler",
	})

	mux := agenthub.NewServeMux()
	mux.HandleFunc("demo_go_handler", func(ctx *agenthub.Context, job *agenthub.Job) error {
		ctx.Log("received payload: %#v", ctx.Payload())
		_, _ = ctx.Progress(50, "working")
		return nil
	})

	if err := client.Run(context.Background(), mux); err != nil {
		panic(err)
	}
}
```

`Run` validates the registered Go agents against the mux before syncing the
registry. A missing handler fails locally before Agent Hub can schedule work to
that executor.

For local source integration when testing unreleased changes, consumers can use
a temporary Go module replace:

```go
require github.com/emosamastudio/agent-hub/sdks/go/agenthub v0.0.0

replace github.com/emosamastudio/agent-hub/sdks/go/agenthub => ../agent-hub/sdks/go/agenthub
```

## Demo Node Worker

The SDK package includes a real worker example that registers `demo_node_worker`, polls through the executor protocol, reports progress, records log/custom trace spans, and reports the result through the SDK.

```bash
npm run build -w @agent-hub/sdk
npm run hub:demo-worker -- --once
```

Use `--once` to register the demo agent and process at most one queued execution. Omit `--once` to keep the worker running.

## Agent CLI

`@agent-hub/sdk` also builds an `agent-hub` CLI for coding agents and local scripts. It uses dashboard Basic Auth for dashboard CRUD/operation APIs and the project API key for agent trigger APIs.

```bash
npm run build -w @agent-hub/sdk

node packages/sdk/dist/cli.js health
node packages/sdk/dist/cli.js ready
node packages/sdk/dist/cli.js metrics
node packages/sdk/dist/cli.js doctor --project oph
node packages/sdk/dist/cli.js ops status --project oph --strict --fail-on-warning --execution-limit 5
node packages/sdk/dist/cli.js ops observe --project oph --iterations 24 --interval-ms 3600000 --strict --fail-on-warning --execution-limit 5
node packages/sdk/dist/cli.js ops recovery-plan --project oph --backup-dir /var/backups/agent-hub
node packages/sdk/dist/cli.js ops recovery-drill-plan --project oph --backup-dir /var/backups/agent-hub
node packages/sdk/dist/cli.js ops recovery-drill run --project oph --yes-reset-restore-db
node packages/sdk/dist/cli.js ops release-check --project oph --canary-agent enrich_repo --observe-iterations 2 --observe-interval-ms 300000
npm run hub -- health
node packages/sdk/dist/cli.js projects list
node packages/sdk/dist/cli.js projects ensure oph \
  --display-name "Open Source Project Hunter" \
  --description "OPH executor integration"
node packages/sdk/dist/cli.js projects create oph \
  --display-name "Open Source Project Hunter" \
  --description "OPH executor integration"
node packages/sdk/dist/cli.js projects rotate-key oph
node packages/sdk/dist/cli.js projects drain oph --cancel-running
node packages/sdk/dist/cli.js projects disable oph
node packages/sdk/dist/cli.js projects enable oph
node packages/sdk/dist/cli.js mcp config --name agent-hub-oph --node-entry packages/sdk/dist/mcp.js
node packages/sdk/dist/cli.js scheduler status --project oph
node packages/sdk/dist/cli.js agents list --project oph --status online
node packages/sdk/dist/cli.js agents list --archived only
node packages/sdk/dist/cli.js agents get <agent-id> --include-archived
node packages/sdk/dist/cli.js agents get deep_research --project oph
node packages/sdk/dist/cli.js agents create demo_agent \
  --display-name "Demo Agent" \
  --description "Runs a manually managed demo task for Agent Hub validation" \
  --type cron_task \
  --cron "*/5 * * * *" \
  --handler demo_handler \
  --concurrency 1 \
  --timeout-seconds 600
node packages/sdk/dist/cli.js agents update <agent-id> \
  --cron "*/15 * * * *" \
  --retry-max 1
node packages/sdk/dist/cli.js agents schedule-preview deep_research --project oph --limit 5
node packages/sdk/dist/cli.js agents disable deep_research --project oph
node packages/sdk/dist/cli.js agents enable deep_research --project oph
node packages/sdk/dist/cli.js agents drain relationship_agent --project oph --cancel-running
node packages/sdk/dist/cli.js agents delete deep_research --project oph
node packages/sdk/dist/cli.js executors list --project oph
node packages/sdk/dist/cli.js alerts list --limit 20
node packages/sdk/dist/cli.js alerts acknowledge <alert-id> --by agent
node packages/sdk/dist/cli.js executions list --project oph --status queued --limit 20
node packages/sdk/dist/cli.js executions list --project oph --agent deep_research --status failed --limit 20
node packages/sdk/dist/cli.js executions get <execution-id>
node packages/sdk/dist/cli.js executions inspect <execution-id>
node packages/sdk/dist/cli.js executions wait <execution-id> --timeout-ms 600000 --interval-ms 1000 --require-success
node packages/sdk/dist/cli.js executions cancel <execution-id>
node packages/sdk/dist/cli.js executions rerun <execution-id>
node packages/sdk/dist/cli.js traces list <execution-id>
node packages/sdk/dist/cli.js trigger demo_agent \
  --payload '{"source":"cli"}' \
  --idempotency-key demo:cli \
  --dedup-policy skip_if_running
node packages/sdk/dist/cli.js trigger demo_agent \
  --payload '{"source":"canary"}' \
  --dedup-policy allow_duplicate \
  --wait \
  --timeout-ms 600000 \
  --require-success
node packages/sdk/dist/cli.js canary run enrich_repo \
  --project oph \
  --payload '{"repo_name":"agent-hub-smoke"}' \
  --timeout-ms 600000
```

Project-scoped read commands such as `agents list`, `executors list`, and `scheduler status` accept project names or ids. Agent-level commands accept either an agent id or an agent name. When using names across multiple projects, pass `--project <name-or-id>` so the SDK resolves the active agent safely and rejects ambiguous matches. `agents drain` disables scheduling and executor polling for an agent, cancels queued executions, and only cancels running executions when `--cancel-running` is explicitly provided. `agents delete` and registry deregistration refuse agents that still have queued or running executions. Cancel or drain active work before deleting an agent. Once accepted, delete/deregister archives the agent, removes it from active dashboard/API lists, disables scheduling and executor polling for it, and preserves terminal execution/trace history for audit. Use `agents list --archived only` and `agents get --include-archived` to inspect archived agents and their retained history.

`scheduler status` returns the control-plane scheduler snapshot for active agents, including queued/running counts, active concurrency, queue capacity, dispatch state, schedule state, cron due timestamp, and next run timestamp. Use it before debugging a worker to distinguish "nothing due", "executor offline", "queue full", and "ready to dispatch".

`executors list` shows online executor heartbeats and active execution counts. `alerts list` and `alerts acknowledge` expose the operational alert loop for agents, so a coding agent can inspect queue/failure pressure and mark handled alerts without using the dashboard.

`executions list` accepts `--project <name-or-id>` and `--agent <agent-id-or-name>` so agents can inspect OPH runs by project and agent name without first resolving internal ids. Use `--agent-id` when a script already has the exact id.

`executions inspect <execution-id>` returns the execution detail, trace spans, and trigger-chain context in one JSON bundle. Use it as the first drill-down command after a failed or timed-out run appears in `executions list`.

`doctor --project <name-or-id>` runs the agent-facing deployment diagnostic in one call. It checks health, readiness, metrics, scheduler state, project discovery, registered agents, executor heartbeats, and active alerts, then returns a structured report with `ok`, `summary.errors`, `summary.warnings`, and per-check details.

`ops status --project <name-or-id>` returns the higher-level operations snapshot for coding agents. It includes the doctor report, metrics, detailed scheduler state, project-scoped agents, executor heartbeats, active alerts, queued/running/failed/timeout execution samples, and a compact summary with queue, failure, online-agent, and alert counts. Add `--strict` when using it as a deployment gate; the CLI still prints the JSON snapshot, but exits non-zero if the snapshot reports `ok: false`. Add `--fail-on-warning` when active alerts, missing executors, or scheduler warnings should also fail the gate. Use `--execution-limit <n>` to control how many execution samples are returned per status bucket.

`ops observe --project <name-or-id>` runs repeated `ops status` snapshots and returns a JSON report with `iterations`, `failedIterations`, and `snapshots`. For a 24-hour OPH observation window, use `--iterations 24 --interval-ms 3600000 --strict --fail-on-warning`; the command prints the full observation report and exits non-zero if any snapshot is unhealthy.

`ops recovery-plan --project <name-or-id>` generates backup, upgrade, rollback, and verification commands without exposing the actual `DATABASE_URL`. It is intended for agent-run upgrade prep and incident rollback notes; review the generated commands, run the backup before migration, and keep the printed backup path with the release record.

`ops recovery-drill-plan --project <name-or-id>` generates a safe restore rehearsal against a disposable database referenced by `AGENT_HUB_RESTORE_DATABASE_URL`. It includes source and restore database preflight checks, backup creation, restore database reset, restore import, migration replay, and table-level integrity checks. The generated commands never print either database URL.

`ops recovery-drill run --project <name-or-id> --yes-reset-restore-db` executes that restore rehearsal and returns a structured command-by-command report. The confirmation flag is required because the restore database schema is dropped and recreated. The command refuses to continue if `DATABASE_URL` and `AGENT_HUB_RESTORE_DATABASE_URL` are missing or equal.

`ops release-check --project <name-or-id>` runs the release gate for agent-driven deployment: doctor, warning-aware ops status, optional recovery drill, optional canary, and observation. It returns a step-by-step report and exits non-zero if any executed step fails. Add `--include-recovery-drill --yes-reset-restore-db` when a disposable restore database is configured, and `--canary-agent <name>` when an executor can safely run a smoke job.

`executions wait` polls one execution until it reaches `success`, `failed`, `timeout`, or `cancelled`. It is intended for agent-driven smoke tests and canaries after `trigger` returns an execution id. Add `--require-success` when the command should fail on `failed`, `timeout`, or `cancelled`.

`trigger --wait` triggers the agent, reads the returned `execution_id`, then waits for the terminal execution record. Use it when a script already performed its own preflight checks.

`canary run` is the higher-level smoke path for coding agents. It runs `doctor` before the trigger, triggers the agent with `allow_duplicate` by default, waits with `requireSuccess=true` by default, then runs `doctor` again after the execution reaches success.

`projects ensure` is the preferred setup command for consumer repositories. It returns an existing project by name without changing its API key, or creates the project and returns the one-time plaintext key when missing.

`projects drain <name-or-id>` is the project-level stop switch for incidents and maintenance. It disables every active agent in the project, cancels queued executions, and only cancels running executions when `--cancel-running` is explicitly provided.

`projects disable <name-or-id>` and `projects enable <name-or-id>` toggle scheduling for every active agent in a project without cancelling existing work. Use `projects enable` after a maintenance drain when the executor rollout is ready to accept work again.

Agent creation and SDK registry sync require a clear `description`; treat it as part of the public operator contract for each agent.

CLI connection defaults match local dev:

- `AGENT_HUB_URL` or `--url`, default `http://127.0.0.1:8788`
- `AGENT_HUB_API_KEY` or `--api-key`, default `agent_hub_dev_key`
- `AGENT_HUB_DASHBOARD_USER` or `--dashboard-user`, default `admin`
- `AGENT_HUB_DASHBOARD_PASSWORD` or `--dashboard-password`, default `admin`

## Agent MCP Server

The same SDK package also builds a stdio MCP server for MCP-capable coding agents. It exposes the same control-plane operations as tools and uses the same environment variables as the CLI.

```bash
npm run build -w @agent-hub/sdk
npm run hub:mcp
```

Generate a pasteable MCP stdio config for an agent runtime:

```bash
node packages/sdk/dist/cli.js mcp config \
  --name agent-hub-oph \
  --node-entry packages/sdk/dist/mcp.js \
  --url http://127.0.0.1:8788 \
  --api-key "$AGENT_HUB_API_KEY" \
  --dashboard-user "$AGENT_HUB_DASHBOARD_USER" \
  --dashboard-password "$AGENT_HUB_DASHBOARD_PASSWORD"
```

If the SDK package is installed on `PATH`, use the package binary instead:

```bash
agent-hub mcp config --name agent-hub-oph --command agent-hub-mcp
```

Exposed tools:

- `agent_hub_health`
- `agent_hub_ready`
- `agent_hub_get_metrics`
- `agent_hub_doctor`
- `agent_hub_get_ops_status`
- `agent_hub_observe_ops_status`
- `agent_hub_get_recovery_plan`
- `agent_hub_get_recovery_drill_plan`
- `agent_hub_run_recovery_drill`
- `agent_hub_run_release_check`
- `agent_hub_list_projects`
- `agent_hub_ensure_project`
- `agent_hub_create_project`
- `agent_hub_rotate_project_api_key`
- `agent_hub_drain_project`
- `agent_hub_set_project_enabled`
- `agent_hub_get_scheduler_status`
- `agent_hub_list_executors`
- `agent_hub_list_alerts`
- `agent_hub_acknowledge_alert`
- `agent_hub_list_agents`
- `agent_hub_get_agent`
- `agent_hub_create_agent`
- `agent_hub_update_agent`
- `agent_hub_preview_agent_schedule`
- `agent_hub_delete_agent`
- `agent_hub_drain_agent`
- `agent_hub_list_executions`
- `agent_hub_get_execution`
- `agent_hub_inspect_execution`
- `agent_hub_wait_execution`
- `agent_hub_list_traces`
- `agent_hub_trigger_agent`
- `agent_hub_trigger_and_wait_agent`
- `agent_hub_run_canary`
- `agent_hub_set_agent_enabled`
- `agent_hub_cancel_execution`
- `agent_hub_rerun_execution`

Agent MCP tools that target a single agent accept `agentId` as either an id or a name. Pass `project` when targeting by name in a multi-project hub, for example `{ "agentId": "deep_research", "project": "oph", "enabled": false }` with `agent_hub_set_agent_enabled`.

## Development checks

```bash
npm run typecheck
npm run lint -w @agent-hub/web
npm test -w @agent-hub/server
npm test -w @agent-hub/sdk
(cd sdks/go/agenthub && go test ./...)
npm run build
```
