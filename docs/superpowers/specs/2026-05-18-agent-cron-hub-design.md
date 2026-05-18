# Agent Cron Hub — Design Spec

**Status:** Draft
**Date:** 2026-05-18
**Scope:** Transform agent-hub from a local agent monitoring dashboard into a centralized agent cron scheduling and supervision platform (xxl-job for AI agents).

---

## 1. Overview

### 1.1 What This Is

A centralized **agent cron service center** that schedules, dispatches, monitors, and traces AI agent tasks across all managed projects. It provides:

- **Cron-based scheduling** — define when agents run (traditional xxl-job model)
- **On-demand triggering** — projects can call an API to trigger agent execution programmatically
- **Agent registry** — all agents across all projects are visible in one place
- **Execution history** — every run is logged with status, duration, and result
- **LLM trace viewer** — for LLM agents, every model call is captured: prompt → response, tool calls, tokens, latency
- **Real-time monitoring** — WebSocket-driven live dashboard showing what's running right now

### 1.2 What This Is NOT

- **Not a workflow/DAG engine** (use Temporal/Airflow for that)
- **Not an agent execution framework** (agents execute in their own projects)
- **Not a replacement for LangFuse/LangSmith** (we capture traces, but evaluation/prompt management is out of scope)

### 1.3 Inspired By

| Source | What We Borrow |
|--------|---------------|
| **xxl-job** | Admin + Executor architecture, cron management, execution logging, manual trigger |
| **Temporal** | Task Queue concept, Event Sourcing for execution state, heartbeat with payload |
| **Prefect** | Work Pool pattern, rich state machine, decorator-based SDK |
| **LangFuse** | Trace → Observation data model, nested LLM call capture |
| **River (Go)** / **Asynq** | JobArgs+Worker pairing, ServeMux handler registration, LISTEN/NOTIFY |
| **Airflow Grid View** | Execution history as color-coded matrix |

---

## 2. Architecture

### 2.1 System Topology

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent Cron Hub                           │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌───────────┐ │
│  │ Dashboard │  │ REST API │  │  Scheduler │  │ WebSocket │ │
│  │ (React)   │  │ (Fastify)│  │  Engine    │  │ Server    │ │
│  └──────────┘  └────┬─────┘  └─────┬──────┘  └─────┬─────┘ │
│                     │               │               │       │
│              ┌──────┴───────────────┴───────────────┴──────┐│
│              │              PostgreSQL                      ││
│              │  (projects, agents, executions, traces)      ││
│              └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
          ▲                ▲                ▲
          │ HTTP/Pull      │ HTTP/Push      │ HTTP/Pull
          │                │                │
    ┌─────┴─────┐    ┌─────┴─────┐    ┌─────┴─────┐
    │ llm-wiki   │    │    OPH    │    │  future   │
    │ (TS SDK)   │    │ (Go SDK)  │    │ projects  │
    └───────────┘    └───────────┘    └───────────┘
```

### 2.2 Key Design Decisions

**D1: Agent Hub is the scheduling authority.** Projects no longer run their own scheduler loops. Agent Hub owns cron evaluation, job creation, and dispatch. Projects become pure executors.

**D2: Pull-first communication.** Executors long-poll Agent Hub for pending work (penetrates NATs/firewalls). Push (HTTP callback) is secondary, for executors with stable, reachable endpoints.

**D3: PostgreSQL as the single source of truth.** No Redis, no message broker. One database for everything: agent registry, execution state, LLM traces. Simplifies deployment and operations. This is the River/Prefect pattern.

**D4: SDK does the heavy instrumentation.** The SDK auto-captures LLM calls, manages heartbeats, and reports progress. Projects don't write tracing code — they call `ctx.llm.chat()` and tracing happens automatically.

### 2.3 Technology Choices

| Concern | Choice | Why |
|---------|--------|-----|
| **Runtime** | Node.js + Fastify + TypeScript | Keep existing stack, team familiarity |
| **Database** | PostgreSQL | Requested; replaces current SQLite |
| **ORM/Migrations** | `drizzle-orm` + `drizzle-kit` | TypeScript-native, PG support, good DX |
| **Cron Parsing** | `croner` (TypeScript) | 2k+ stars, handles all cron formats, TZ support |
| **WebSocket** | `@fastify/websocket` | Already integrated |
| **Schema Validation** | `zod` (v4) | Already in project |
| **Dashboard** | React + Vite (existing) | Reuse existing dashboard infrastructure |
| **Go SDK** | Custom, referencing River/Asynq patterns | Thin HTTP client + handler registry |
| **Python SDK** | Custom, referencing Celery patterns | Thin HTTP client + decorator-based registration |
| **TypeScript SDK** | Custom, referencing pg-boss patterns | Thin HTTP client + handler registry |

**Libraries explicitly NOT used (and why):**

| Library | Why Not |
|---------|---------|
| `pg-boss` | Designed for workers connecting to same PG — our executors are remote HTTP clients. The internal scheduling logic is straightforward enough without it. |
| `bullmq` | Requires Redis. We use PG-only. |
| `temporal` | Overkill — workflow orchestration, not cron scheduling. Operational complexity too high. |
| `celery` | Python-only, requires broker. Our executors are multi-language HTTP clients. |
| `langfuse` | Full observability platform with ClickHouse — too heavy. We only need the trace data model. |

---

## 3. Data Model

### 3.1 Entity Relationship

```
Project (1) ────< Agent (N) ────< Execution (N) ────< Trace (N)
```

### 3.2 Tables

#### `projects`

```sql
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,          -- 'llm-wiki', 'oph'
  display_name  TEXT NOT NULL,                 -- 'LLM Wiki', 'Open Project Hunter'
  description   TEXT,
  workspace_path TEXT,                          -- filesystem path for workspace actions
  status        TEXT NOT NULL DEFAULT 'active', -- active | inactive | archived
  api_key_hash  TEXT,                           -- hashed API key for SDK auth
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `agents`

```sql
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,               -- unique within project: 'llm_extract'
  display_name    TEXT NOT NULL,               -- 'LLM 知识提取'
  description     TEXT,
  agent_type      TEXT NOT NULL,               -- 'cron_task' | 'llm_agent' | 'agent_loop'
  
  -- Scheduling
  cron_expression TEXT,                         -- NULL = manual trigger only
  enabled         BOOLEAN NOT NULL DEFAULT true,
  concurrency     INTEGER NOT NULL DEFAULT 1,   -- max parallel executions
  timeout_seconds INTEGER NOT NULL DEFAULT 600, -- per-execution timeout
  retry_max       INTEGER NOT NULL DEFAULT 3,
  retry_backoff_base_ms INTEGER NOT NULL DEFAULT 30000, -- 30s base for exponential backoff
  
  -- Handler routing (maps to SDK handler name)
  handler_name    TEXT,                         -- 'refresh_source_channel', 'deep_research'
  
  -- Executor discovery
  executor_host   TEXT,                         -- '10.0.1.5:9191' — SDK registers this
  executor_status TEXT NOT NULL DEFAULT 'offline', -- online | offline | degraded
  
  -- Schema (JSON Schema for input validation)
  input_schema    JSONB,                        -- {'type':'object','properties':{...}}
  
  -- Labels for grouping/filtering
  labels          JSONB DEFAULT '{}',           -- {'env':'prod','team':'data'}
  
  -- Heartbeat
  last_heartbeat_at TIMESTAMPTZ,
  last_execution_at TIMESTAMPTZ,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE(project_id, name)
);

CREATE INDEX idx_agents_project ON agents(project_id);
CREATE INDEX idx_agents_executor_status ON agents(executor_status);
CREATE INDEX idx_agents_enabled ON agents(enabled) WHERE enabled = true;
```

**`agent_type` semantics:**

| Type | cron_expression | LLM Traces | Typical Use |
|------|----------------|------------|-------------|
| `cron_task` | Usually set | No | Shell scripts, data sync, API calls |
| `llm_agent` | Usually set | **Yes** | LLM extraction, research, synthesis |
| `agent_loop` | Usually absent | **Yes** | Long-running ReAct agents (OPH steward) |

#### `executions`

```sql
CREATE TYPE trigger_type AS ENUM ('cron', 'manual', 'api', 'retry');
CREATE TYPE execution_status AS ENUM (
  'queued', 'running', 'success', 'failed', 'timeout', 'cancelled'
);

CREATE TABLE executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  
  -- Trigger info
  trigger_type    trigger_type NOT NULL,
  triggered_by    TEXT,                         -- 'cron', 'user:emo', 'api:oph-steward'
  
  -- Status
  status          execution_status NOT NULL DEFAULT 'queued',
  
  -- Timing
  scheduled_at    TIMESTAMPTZ,                  -- when cron said to fire
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,                      -- computed: finished_at - started_at
  
  -- Result
  input_payload   JSONB,                        -- what was sent to the executor
  result_summary  TEXT,                         -- one-line summary on success
  result_data     JSONB,                        -- structured result from executor
  error_message   TEXT,                         -- error details on failure
  error_stack     TEXT,                         -- stack trace if available
  
  -- Retry
  retry_count     INTEGER NOT NULL DEFAULT 0,
  retry_of        UUID REFERENCES executions(id),
  
  -- Executor info (snapshot at dispatch time)
  executor_host   TEXT,                         -- which executor ran this
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_executions_agent ON executions(agent_id);
CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_scheduled ON executions(scheduled_at);
CREATE INDEX idx_executions_created ON executions(created_at DESC);
CREATE INDEX idx_executions_agent_status ON executions(agent_id, status);
```

#### `traces`

```sql
CREATE TYPE trace_role AS ENUM ('system', 'user', 'assistant', 'tool');

CREATE TABLE traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  
  -- Ordering within execution
  turn_index      INTEGER NOT NULL,             -- 0, 1, 2, ... (ReAct loop turn)
  span_index      INTEGER NOT NULL DEFAULT 0,   -- order within a turn
  parent_span_id  UUID REFERENCES traces(id),   -- for nested spans (tool calls within LLM call)
  
  -- Role & Type
  role            trace_role NOT NULL,
  span_type       TEXT NOT NULL DEFAULT 'llm',  -- 'llm' | 'tool_call' | 'tool_result' | 'custom'
  
  -- Model info (for LLM spans)
  model           TEXT,                         -- 'deepseek-v4-pro', 'claude-opus-4-7'
  provider        TEXT,                         -- 'leihuo', 'anthropic'
  
  -- Content
  input_content   TEXT,                         -- prompt / input (may be large)
  output_content  TEXT,                         -- response / output
  tool_calls      JSONB,                        -- [{name, arguments}]
  tool_results    JSONB,                        -- [{name, result}]
  
  -- Metrics
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_estimate   NUMERIC(10,6),               -- estimated USD cost
  latency_ms      INTEGER,                      -- this span's duration
  
  -- Metadata
  metadata        JSONB DEFAULT '{}',           -- arbitrary key-value
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traces_execution ON traces(execution_id);
CREATE INDEX idx_traces_turn ON traces(execution_id, turn_index);
CREATE INDEX idx_traces_parent ON traces(parent_span_id);
```

### 3.3 Writes Pattern — Append-Only Trace Storage

Following the LangFuse pattern: traces are written **during execution**, not in a batch at the end. Each `ctx.llm.chat()` call immediately POSTs a trace row to the hub. This means:
- Traces are visible in the dashboard in real-time (before execution completes)
- If the execution crashes mid-way, partial traces are preserved
- The SDK batches trace inserts (configurable batch size, default 10, flush interval 2s) to reduce HTTP overhead

### 3.4 Cleanup / Retention

| Table | Default Retention | Configurable |
|-------|------------------|--------------|
| `executions` | 90 days | `AGENT_HUB_EXECUTION_RETENTION_DAYS` |
| `traces` | 30 days | `AGENT_HUB_TRACE_RETENTION_DAYS` |

A background maintenance job (part of the scheduling engine) purges expired rows daily.

---

## 4. Scheduling Engine

### 4.1 Internal Architecture

The scheduler runs inside the Fastify server process (same process as the API/dashboard). It uses a cron-evaluation loop + PostgreSQL-based dispatch with `SELECT ... FOR UPDATE SKIP LOCKED` for concurrency-safe claim semantics.

```
Scheduler (runs every 1 second, configurable via AGENT_HUB_SCHEDULER_TICK_MS)
│
├── 1. CronEvaluator
│     SELECT * FROM agents WHERE enabled=true AND cron_expression IS NOT NULL
│     For each agent:
│       croner.nextRun(cron_expression, last_execution_at) <= now()
│       → INSERT INTO executions (agent_id, trigger_type='cron', status='queued')
│       → UPDATE agents SET last_execution_at = now()
│
├── 2. Matcher (dispatch queued → running when executor is available)
│     SELECT e.* FROM executions e
│     JOIN agents a ON e.agent_id = a.id
│     WHERE e.status = 'queued'
│       AND a.executor_status = 'online'
│       AND (SELECT COUNT(*) FROM executions WHERE agent_id=a.id AND status='running') < a.concurrency
│     ORDER BY e.scheduled_at ASC
│     LIMIT 10
│     FOR UPDATE SKIP LOCKED
│     
│     For each matched execution:
│       → Respond to pending long-poll request, OR
│       → HTTP POST to executor_host
│       → UPDATE execution SET status='running', started_at=now()
│
├── 3. HeartbeatMonitor
│     SELECT * FROM agents WHERE executor_status='online'
│       AND last_heartbeat_at < now() - INTERVAL '30 seconds'
│     → UPDATE SET executor_status = 'offline'
│     → Cancel any running executions for this agent
│
├── 4. TimeoutChecker
│     SELECT * FROM executions WHERE status='running'
│       AND started_at + (agent.timeout_seconds * 1000) < now()
│     → UPDATE SET status='timeout', finished_at=now()
│
├── 5. RetryManager
│     SELECT * FROM executions WHERE status IN ('failed','timeout')
│       AND retry_count < agent.retry_max
│       AND agent.retry_backoff_base_ms IS NOT NULL
│       AND finished_at + backoff_delay < now()
│     → INSERT new execution (retry_of=original.id, retry_count=original.retry_count+1)
│
└── 6. RetentionCleanup (daily)
      DELETE FROM traces WHERE created_at < now() - INTERVAL '30 days'
      DELETE FROM executions WHERE created_at < now() - INTERVAL '90 days'
```

### 4.2 Long-Poll Dispatch (Pull Mode)

The primary dispatch mechanism. Executors call `GET /api/executors/poll` with their agent names. The server holds the connection open (up to 30s). When a matching execution is queued, it returns immediately. If no execution is available within the timeout, it returns `204 No Content` and the executor re-polls.

**Why long-poll:** NAT-friendly, no firewall issues, simple HTTP (no gRPC needed), works with standard HTTP clients in all languages.

**Library reference:** This is the same pattern used by Temporal's `PollWorkflowTaskQueue` and Prefect's worker polling. Implementation uses a `Map<agentId, Deferred[]>` in the server — when the Matcher finds a queued execution, it resolves the oldest pending long-poll request for that agent.

### 4.3 Push Dispatch (Callback)

Secondary mechanism. If an agent's `executor_host` is set and reachable, the hub can POST to `http://{executor_host}/agent-hub/execute` with the execution payload. This has lower latency than pull, and is used primarily for agents on the same network.

### 4.4 Leader Election (for HA)

When running multiple hub instances, only one scheduler should be active. Leader election uses PostgreSQL advisory locks (`pg_advisory_lock`), following the River pattern:

```sql
-- Non-blocking try-lock
SELECT pg_try_advisory_lock(42);  -- returns true if acquired
```

The instance that holds the lock runs the scheduler tick. If the instance crashes, the lock is released and another instance acquires it. No external coordinator needed.

---

## 5. SDK Design

### 5.1 Common SDK Layers

All three language SDKs (TypeScript, Go, Python) provide the same three-layer API:

```
Layer 1: Registration   — register agent spec with the hub
Layer 2: Execution      — pull jobs, execute handlers, heartbeat, report results
Layer 3: Instrumentation — auto-capture LLM traces
```

### 5.2 TypeScript SDK

**Package:** `@agent-hub/sdk` (published to npm, or workspace reference)

**Dependencies:** zero required (uses built-in `fetch` in Node 20+), optional `@anthropic-ai/sdk` / `openai` for auto-instrumentation.

```typescript
import { AgentHubClient } from '@agent-hub/sdk';

const hub = new AgentHubClient({
  serverUrl: 'http://agent-hub.internal:8787',
  project: 'llm-wiki',
  apiKey: process.env.AGENT_HUB_API_KEY,
});

// Layer 1: Register an agent
hub.register({
  name: 'llm_extract',
  displayName: 'LLM 知识提取',
  agentType: 'llm_agent',
  cron: '0 */6 * * *',
  handler: 'llm_extract_handler',
  inputSchema: {
    type: 'object',
    properties: { source_id: { type: 'string' } },
  },
  concurrency: 2,
  timeoutSeconds: 300,
  retryMax: 3,
});

// Layer 2: Define handler
hub.handle('llm_extract_handler', async (ctx) => {
  await ctx.log('Starting extraction...');
  await ctx.progress(0.3, 'Fetching source...');

  // Layer 3: LLM call — auto-traced
  const response = await ctx.llm.chat({
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'Extract structured knowledge from the source.' },
      { role: 'user', content: ctx.payload.source_text },
    ],
    // ↑ This single call automatically records in the traces table:
    //   - input_content (full messages)
    //   - output_content (full response)
    //   - model, provider
    //   - input_tokens, output_tokens (from response headers)
    //   - latency_ms
  });

  // Manual tracing for non-LLM operations
  const span = ctx.trace.startSpan('save_to_database');
  try {
    await db.insert(response);
    span.setOutput({ rows: response.entities.length });
  } finally {
    span.end();
  }

  return { entities: response.entities };
});

// Start pulling jobs and executing
await hub.start();
```

**Auto-instrumentation support:**
- `ctx.llm.chat()` — generic LLM call (works with any OpenAI-compatible API)
- `ctx.llm.anthropic()` — Claude-specific (captures tool_use blocks)
- `ctx.llm.openai()` — OpenAI-specific (captures function calls)

If the project uses the Anthropic SDK or OpenAI SDK directly, they can also use a **patch function**:
```typescript
import { patchAnthropic } from '@agent-hub/sdk/anthropic';
const client = patchAnthropic(new Anthropic(), hub.currentExecution);
// Now all client.messages.create() calls are auto-traced
```

### 5.3 Go SDK

**Module:** `github.com/emosama/agent-hub-sdk-go`

**Dependencies:** standard library (`net/http`, `encoding/json`). Pattern follows Asynq's `ServeMux`.

```go
package main

import (
    "context"
    "os"
    agenthub "github.com/emosama/agent-hub-sdk-go"
)

type DeepResearchHandler struct{}

func (h *DeepResearchHandler) Handle(ctx agenthub.Context, job *agenthub.Job) error {
    ctx.Log("Starting deep research on %s", job.Payload["repo_name"])
    
    // LLM call — auto-traced
    resp, err := ctx.LLM().Chat(ctx, agenthub.ChatRequest{
        Model: "deepseek-v4-pro",
        Messages: []agenthub.Message{
            {Role: "system", Content: "You are a deep research analyst..."},
            {Role: "user", Content: fmt.Sprintf("Research this repo: %s", job.Payload["repo_name"])},
        },
    })
    if err != nil {
        return err
    }
    
    return ctx.Report(agenthub.Result{
        Summary: "Research completed",
        Data:    resp.Content,
    })
}

func main() {
    client := agenthub.NewClient(agenthub.Config{
        ServerURL: os.Getenv("AGENT_HUB_URL"),
        Project:   "oph",
        APIKey:    os.Getenv("AGENT_HUB_API_KEY"),
    })
    
    // Layer 1: Registration
    client.Register(agenthub.AgentSpec{
        Name:         "deep_research",
        DisplayName:  "Deep Research",
        AgentType:    agenthub.AgentTypeLLM,
        Cron:         "0 */2 * * *",
        Handler:      "deep_research_handler",
        Concurrency:  3,
        TimeoutSecs:  600,
        RetryMax:     2,
    })
    
    // Layer 2: Handler binding (Asynq-style ServeMux)
    mux := agenthub.NewServeMux()
    mux.HandleFunc("deep_research_handler", (&DeepResearchHandler{}).Handle)
    mux.HandleFunc("enrich_repo_handler", handleEnrichRepo)
    
    // Start pull loop
    client.Run(context.Background(), mux)
}
```

### 5.4 Python SDK

**Package:** `agent-hub-sdk` (PyPI)

**Dependencies:** `httpx` (async HTTP), optional `openai` / `anthropic` for auto-instrumentation.

```python
from agent_hub_sdk import AgentHubClient, agent, llm

hub = AgentHubClient(
    server_url="http://agent-hub.internal:8787",
    project="llm-wiki",
    api_key=os.environ["AGENT_HUB_API_KEY"],
)

# Layer 1: Decorator-based registration (Prefect/Celery style)
@agent(
    name="llm_synthesize",
    display_name="LLM Synthesis",
    agent_type="llm_agent",
    cron="0 0 */2 * *",  # every 2 days
    concurrency=1,
    timeout_seconds=600,
    retry_max=2,
)
async def llm_synthesize(ctx):
    await ctx.log("Starting synthesis...")
    await ctx.progress(0.5, "Calling LLM...")
    
    # Layer 3: Auto-traced LLM call
    response = await ctx.llm.chat(
        model="deepseek-v4-pro",
        messages=[
            {"role": "system", "content": "Synthesize findings from multiple sources."},
            {"role": "user", "content": ctx.payload["combined_text"]},
        ],
    )
    
    return {"synthesis": response.content}

# Start the pull loop
await hub.start()
```

### 5.5 SDK-Hub Protocol

All SDKs communicate with the hub over HTTP. The protocol has 4 endpoints:

| Endpoint | Method | Purpose | Called By |
|----------|--------|---------|-----------|
| `/api/registry/agents` | PUT | Register/update agent spec | SDK on startup |
| `/api/executors/heartbeat` | POST | Send heartbeat with optional progress | SDK every 10s |
| `/api/executors/poll` | GET | Long-poll for pending executions | SDK in pull loop |
| `/api/executions/:id/report` | POST | Report execution result + traces batch | SDK on completion |

**Authentication:** `Authorization: Bearer <api_key>` header on all requests. The API key is hashed (SHA-256) and stored in `projects.api_key_hash`.

### 5.6 SDK Internals (Shared)

Each SDK runs an internal loop:

```
┌────────────────────────────────────────┐
│              SDK Internal Loop         │
│                                        │
│  1. Startup: PUT /api/registry/agents  │
│     (registers all agents)             │
│                                        │
│  2. Heartbeat goroutine (every 10s)    │
│     POST /api/executors/heartbeat      │
│     (includes progress for running     │
│      executions)                       │
│                                        │
│  3. Main loop:                         │
│     GET /api/executors/poll            │
│     (long-poll, up to 30s timeout)     │
│                                        │
│     If execution received:             │
│     ├── Lookup handler by name         │
│     ├── Run handler                    │
│     │   └── (LLM calls auto-traced)    │
│     ├── Flush trace batch              │
│     └── POST /api/executions/:id/report│
│                                        │
│  4. Graceful shutdown:                 │
│     - Stop pulling new jobs            │
│     - Finish in-flight execution       │
│     - Deregister agents                │
└────────────────────────────────────────┘
```

---

## 6. API Design

### 6.1 Public API (for SDKs / project integration)

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/registry/agents` | Register/update agent(s) for a project |
| `DELETE` | `/api/registry/agents/:name` | Deregister an agent |
| `GET` | `/api/executors/poll` | Long-poll for pending executions |
| `POST` | `/api/executors/heartbeat` | Executor heartbeat + progress |
| `POST` | `/api/executions/:id/report` | Report execution result |
| `POST` | `/api/executions/:id/traces` | Append trace records (batch) |
| `POST` | `/api/agents/:name/trigger` | Trigger an agent manually (for OPH steward, etc.) |

### 6.2 Dashboard API (for React frontend)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all projects with agent counts, health summary |
| `GET` | `/api/agents` | List agents with filters (project, type, status, labels) |
| `GET` | `/api/agents/:id` | Agent detail with stats, last 10 execution status dots |
| `PATCH` | `/api/agents/:id` | Update agent (enable/disable, change cron, change concurrency) |
| `GET` | `/api/executions` | Paginated execution list with filters |
| `GET` | `/api/executions/:id` | Execution detail (timing, result, input/output) |
| `GET` | `/api/executions/:id/traces` | All traces for an execution (nested tree) |
| `POST` | `/api/executions/:id/cancel` | Cancel a running execution |
| `GET` | `/api/stats` | Aggregate stats (success rate, avg latency, queue depth) |
| `GET` | `/api/ws` | WebSocket upgrade for real-time updates |

### 6.3 WebSocket Events

The hub pushes these events to the dashboard:

```typescript
type WsEvent =
  | { type: 'agent.updated'; agent: Agent }
  | { type: 'execution.created'; execution: Execution }
  | { type: 'execution.updated'; execution: Execution }  // status change
  | { type: 'trace.appended'; executionId: string; trace: Trace }
  | { type: 'heartbeat.received'; agentId: string; progress?: ProgressUpdate }
  | { type: 'scheduler.tick'; stats: SchedulerStats };
```

---

## 7. Dashboard Design

### 7.1 Page Structure

```
Left Sidebar Navigation:
├── 📊 Overview        — aggregate stats, recent activity, health overview
├── 🤖 Agents           — agent CRUD, cron management, status toggles
├── 📋 Executions       — execution history with filters
│   └── Execution Detail — timeline, traces, logs
├── 📈 Analytics        — success rates, latency distributions, cost trends
└── ⚙️ Settings         — projects, API keys, retention config
```

### 7.2 Key Views (from UI Research)

**Agents List** — reference: xxl-job task management + Argo cron dots

```
┌──────────────────────────────────────────────────────────────────────┐
│ Agents                                    [+ Register New Agent]     │
│                                                                      │
│ Filters: [Project ▾] [Type ▾] [Status ▾]  Search: [___________]     │
│                                                                      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Project │ Agent         │ Cron         │ Status  │ Last 10   │ ⚙│ │
│ ├─────────┼───────────────┼──────────────┼─────────┼───────────┼──┤ │
│ │ llm-wiki│ llm_extract   │ 0 */6 * * *  │ 🟢 on   │ 🟢🟢🟢🔴🟢  │ →│ │
│ │ OPH     │ deep_research │ 0 */2 * * *  │ 🟢 on   │ 🟢🟢🟢🟢🟢  │ →│ │
│ │ OPH     │ relationship  │ 0 * * * *    │ 🟡 idle │ ⚪⚪⚪⚪⚪  │ →│ │
│ │ llm-wiki│ sync_wiki     │ */15 * * * * │ 🔴 off  │ 🟢🟢🔴🔴—  │ →│ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ Status dots: 🟢 success 🔴 failed ⚪ no data — disabled              │
└──────────────────────────────────────────────────────────────────────┘
```

**Execution Detail** — reference: Temporal Timeline + LangFuse Trace Tree

```
┌──────────────────────────────────────────────────────────────────────┐
│ Execution: llm_extract #482                          ← Back to list  │
│                                                                      │
│ Status: ✅ Success    Duration: 2.3s    Trigger: cron (06:00)       │
│ Agent: llm-wiki/llm_extract    Executor: 10.0.1.5:9191              │
│                                                                      │
│ ┌─ Timeline ──────────────────────────────────────────────────────┐ │
│ │                                                                  │ │
│ │  06:00:00  ⬆ Execution created (queued)                         │ │
│ │  06:00:01  ⬆ Dispatched to executor                             │ │
│ │  06:00:01  ⬆ Execution started                                  │ │
│ │                                                                  │ │
│ │  ┌─ LLM Call #1 ──────────────────────────── 1.8s ────────────┐│ │
│ │  │  Model: deepseek-v4-pro    Tokens: 1,234→456   Cost: $0.003 ││ │
│ │  │                                                              ││ │
│ │  │  System Prompt                   [expand ▸]                  ││ │
│ │  │  User Message                    [expand ▸]                  ││ │
│ │  │  Assistant Response              [expand ▸]                  ││ │
│ │  │  ┌─ Tool Call: get_entity   0.3s ───────────────────────┐   ││ │
│ │  │  │  Arguments: {"name": "OpenAI"}                        │   ││ │
│ │  │  │  Result: {"type": "organization", ...}                │   ││ │
│ │  │  └───────────────────────────────────────────────────────┘   ││ │
│ │  └──────────────────────────────────────────────────────────────┘│ │
│ │                                                                  │ │
│ │  06:00:02  ⬆ Execution completed                                │ │
│ │                                                                  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**Overview Dashboard** — reference: Sidekiq status cards + Dagster run timeline

```
┌──────────────────────────────────────────────────────────────────────┐
│ Agent Cron Hub                                          [Auto-refresh]│
│                                                                      │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│ │ Projects │ │ Agents   │ │ Running  │ │ Failed   │                │
│ │    2     │ │   12     │ │    3     │ │    1     │                │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                │
│                                                                      │
│ ┌─ Queue Depth ───────────────────────────────────────────────────┐ │
│ │  llm-wiki:  ▓▓▓░░░░░ 3 queued   OPH: ░░░░░░░░░ 0 queued        │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ ┌─ Recent Executions ──────────────────────────────────────────────┐│
│ │  Time     Agent            Status    Duration                     ││
│ │  06:00    llm_extract      ✅        2.3s                         ││
│ │  06:00    deep_research    🔄        45s (running)                ││
│ │  05:45    sync_wiki        ✅        0.8s                         ││
│ │  05:30    relationship     ❌        12s (timeout)                ││
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 8. Hub API for External Trigger

OPH steward or any external program can trigger an agent on-demand:

```bash
# Manual trigger with payload
curl -X POST http://agent-hub.internal:8787/api/agents/deep_research/trigger \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "triggered_by": "oph-steward",
    "payload": {
      "repo_id": "12345",
      "repo_name": "anthropics/claude-code"
    }
  }'
```

This creates an execution with `trigger_type='api'` and returns the execution ID. The execution then flows through the normal dispatch (pull or push).

---

## 9. Implementation Phases

### Phase 1: Foundation (agent-hub core)
- Clean up existing agent-hub codebase (remove agent discovery, mock runtime, etc.)
- Set up PostgreSQL + Drizzle ORM migrations
- Implement core tables: `projects`, `agents`, `executions`, `traces`
- Build the scheduling engine (CronEvaluator, Matcher, HeartbeatMonitor, TimeoutChecker)
- Hub API for agent registration and executor poll/heartbeat/report
- **Estimated:** core infrastructure

### Phase 2: TypeScript SDK + OPH Migration (Go SDK)
- Build `@agent-hub/sdk` (TypeScript)
- Build `agent-hub-sdk-go` (Go) — priority since OPH uses Go
- Migrate OPH agents to use Go SDK:
  - `deep_research` (currently `agent-v5.mjs`) 
  - `relationship_agent` (currently `agent-v6.mjs`)
  - Worker enrich stage (LLM enrichment)
  - Steward loop checks → triggered via API
- **Estimated:** SDK development + OPH integration

### Phase 3: Dashboard
- Agent list view with cron management
- Execution history with filters
- Execution detail with timeline + LLM trace viewer
- Overview dashboard with stats and queue depth
- Real-time WebSocket updates
- **Estimated:** dashboard rebuild (reusing existing React infrastructure)

### Phase 4: Python SDK + llm-wiki Migration
- Build `agent-hub-sdk` (Python)
- Migrate llm-wiki agents:
  - `llm_extract` 
  - `llm_synthesize`
  - `refresh_source_channel`
  - `sync_wiki`
- **Estimated:** Python SDK + llm-wiki refactor

### Phase 5: Production hardening
- Multi-instance hub with leader election
- Retention cleanup automation
- Cost tracking aggregation
- Alerting (Slack/email on failures)
- API key management UI

---

## 10. Migration from Current agent-hub

### 10.1 What Gets Removed

The current agent-hub is a local agent discovery and monitoring tool. The following features are **out of scope** for the new system and will be removed in Phase 1:

| Feature | Reason for Removal |
|---------|-------------------|
| Copilot CLI session discovery (`~/.copilot/session-state`) | No longer a local-only tool |
| Claude Code session discovery (`~/.claude/projects`) | No longer a local-only tool |
| Gemini CLI session discovery (`~/.gemini/tmp`) | No longer a local-only tool |
| OpenClaw gateway discovery | No longer a local-only tool |
| Mock runtime / demo activity | Replaced by real agent registry |
| Runtime bridges (Copilot SDK, Claude resume, Gemini resume) | Agents execute via SDK in their own projects |
| Inbox triage (acknowledge/snooze/mute) | Replaced by execution status management |
| Workspace actions (open in Finder/Terminal) | Out of scope |
| Reference catalog (curated GitHub projects) | Out of scope |
| Desktop notifications | Replaced by alerting in Phase 5 |
| Chinese/English UI switch | Not needed for v1; re-add later if needed |

### 10.2 What Gets Kept (Repurposed)

| Feature | Repurposed As |
|---------|--------------|
| Fastify + WebSocket server | Core hub server (API + WS + scheduler) |
| React + Vite dashboard | New dashboard (reuse layout, WebSocket client, patterns) |
| `packages/shared` contracts | Redesigned for agents/executions/traces schema |
| `zod` validation patterns | Input validation for API endpoints |
| `examples/reference-sidecar.mjs` | Reference example for TypeScript SDK usage |
| SQLite → PostgreSQL migration pattern | Keep Drizzle, switch dialect |

### 10.3 What Gets Added

Everything in Sections 3-9 above: PostgreSQL schema, scheduling engine, SDK (TS/Go/Python), new dashboard views, external trigger API.

---

## 11. Open Decisions

These are deferred to the implementation plan stage:

1. **PostgreSQL connection:** netease-pub PostgreSQL host/port/credentials setup
2. **Auth model:** API key per project? Per agent? Shared secret?
3. **Multi-tenancy:** Is there a concept of "organization" above project?
4. **Dashboard tech:** Keep existing React + Vite? Migrate to something else?
5. **Deployment:** Docker compose on netease-pub? Systemd? Separate VM?
6. **Existing code cleanup:** How much of the current agent-hub (agent discovery, Copilot/Claude/Gemini bridging) to keep vs. remove?

---

## 12. References

| Project | URL | Relevance |
|---------|-----|-----------|
| xxl-job | https://github.com/xuxueli/xxl-job | Architecture reference |
| Temporal | https://github.com/temporalio/temporal | Task Queue, Event Sourcing |
| Prefect | https://github.com/PrefectHQ/prefect | Work Pool, State Machine |
| LangFuse | https://github.com/langfuse/langfuse | Trace data model |
| River | https://github.com/riverqueue/river | Go PG job queue |
| Asynq | https://github.com/hibiken/asynq | Go Redis job queue |
| croner | https://github.com/Hexagon/croner | TypeScript cron parser |
| drizzle-orm | https://github.com/drizzle-team/drizzle-orm | TypeScript ORM |
