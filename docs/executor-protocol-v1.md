# Agent Hub Executor Protocol v1

Agent Hub is the scheduler/control plane. Consumer projects run executors in
their own repository and communicate through this protocol.

## Versioning

Executor clients must send:

```http
Agent-Hub-Version: 1
Authorization: Bearer <project-api-key>
```

`X-Agent-Hub-Project: <project-name>` is optional metadata. Project ownership is
resolved from the bearer API key.

Agent Hub responds to API requests with:

```http
Agent-Hub-Version: 1
```

Bearer/API-key requests that send an unsupported `Agent-Hub-Version` are
rejected with `426 Upgrade Required` and:

```json
{
  "error": "unsupported_agent_hub_version",
  "requested_version": "2",
  "supported_versions": ["1"]
}
```

## Go SDK Reference

The Go SDK module path is:

```go
github.com/emosamastudio/agent-hub/sdks/go/agenthub
```

Production consumers should use a tagged version:

```go
require github.com/emosamastudio/agent-hub/sdks/go/agenthub v0.2.0
```

Because the SDK is a nested Go module, the matching git tag must be created with
the module directory prefix:

```bash
git tag sdks/go/agenthub/v0.2.0
git push origin sdks/go/agenthub/v0.2.0
```

Local source integration can use a temporary replace:

```go
replace github.com/emosamastudio/agent-hub/sdks/go/agenthub => ../agent-hub/sdks/go/agenthub
```

`v0.2.0` is the first Go SDK tag compatible with Agent Hub servers that require
agent descriptions during registry sync. Consumers using `v0.1.0` must upgrade
before syncing agents against this protocol version, otherwise registrations
without `description` will be rejected with field-level validation details.

## Project Setup

Create or find the OPH project. `projects ensure` is idempotent: it returns the
existing project without rotating keys, and only returns a one-time plaintext
API key when it creates a missing project.

```bash
npm run build -w @agent-hub/sdk
node packages/sdk/dist/cli.js projects list
node packages/sdk/dist/cli.js projects ensure oph \
  --display-name "Open Source Project Hunter" \
  --description "OPH executor integration"
```

The response contains:

```json
{
  "project": {
    "id": "<project-id>",
    "name": "oph"
  },
  "api_key": "agh_..."
}
```

Store the key as:

```bash
AGENT_HUB_PROJECT=oph
AGENT_HUB_API_KEY=agh_...
```

Rotate the key:

```bash
node packages/sdk/dist/cli.js projects rotate-key <project-id>
```

## Stable Endpoints

### Register Agent

```http
PUT /api/registry/agents
```

Request fields:

```json
{
  "name": "deep_research",
  "displayName": "Deep Research",
  "description": "Runs OPH deep repository research jobs and reports structured research results.",
  "agentType": "llm_agent",
  "cron": "0 * * * *",
  "handler": "deep_research_handler",
  "inputSchema": {},
  "concurrency": 1,
  "timeoutSeconds": 600,
  "retryMax": 2,
  "maxPendingQueue": 100,
  "misfirePolicy": "fire_once",
  "executorHost": "host-1",
  "labels": {
    "service": "oph"
  }
}
```

Stable response fields:

```json
{
  "id": "<agent-id>",
  "projectId": "<project-id>",
  "name": "deep_research",
  "displayName": "Deep Research",
  "description": "Runs OPH deep repository research jobs and reports structured research results.",
  "agentType": "llm_agent",
  "handlerName": "deep_research_handler",
  "timeoutSeconds": 600
}
```

`description` is required and must clearly explain the agent's responsibility. Agent Hub rejects empty or missing descriptions so the dashboard, CLI, MCP tools, and operators can identify every registered agent without reading consumer-project code.

### Heartbeat

```http
POST /api/executors/heartbeat
```

Request fields:

```json
{
  "agent_names": ["deep_research", "relationship_agent"],
  "executions": [
    {
      "execution_id": "<execution-id>",
      "progress_percent": 50,
      "progress_message": "working"
    }
  ]
}
```

Stable response fields:

```json
{
  "ok": true,
  "executions_updated": 1,
  "cancelled_execution_ids": []
}
```

### Poll

```http
GET /api/executors/poll?agent_names=deep_research,relationship_agent
```

No work response:

```http
204 No Content
```

Stable work response fields:

```json
{
  "id": "<execution-id>",
  "agentId": "<agent-id>",
  "agentName": "deep_research",
  "handlerName": "deep_research_handler",
  "triggerType": "manual",
  "status": "running",
  "inputPayload": {
    "repo_name": "example/repo"
  },
  "timeoutSeconds": 600
}
```

### Report

```http
POST /api/executions/:id/report
```

Request fields:

```json
{
  "status": "success",
  "result_summary": "done",
  "result_data": {},
  "error_message": "",
  "error_stack": "",
  "trace_count_expected": 0
}
```

Stable success response:

```json
{
  "ok": true
}
```

## Manual Integration Test

After OPH registers `deep_research`, create a queued execution and wait for its terminal status:

```bash
node packages/sdk/dist/cli.js trigger deep_research \
  --api-key "$AGENT_HUB_API_KEY" \
  --payload '{"repo_name":"agent-hub-smoke"}' \
  --dedup-policy allow_duplicate \
  --wait \
  --timeout-ms 600000 \
  --require-success
```

Then OPH should be able to poll and report it through the Go SDK before the wait timeout expires.

Useful checks:

```bash
node packages/sdk/dist/cli.js agents list --project <project-id>
node packages/sdk/dist/cli.js scheduler status --project <project-id>
node packages/sdk/dist/cli.js executors list --project <project-id>
node packages/sdk/dist/cli.js executions list --status queued --limit 20
```
