# Agent Cron Hub — Design Spec

**Status:** Draft (revised after architecture stress-test)
**Date:** 2026-05-18
**Scope:** Transform agent-hub from a local agent monitoring dashboard into a centralized agent cron scheduling and supervision platform (xxl-job for AI agents).

---

## 1. Overview

### 1.1 What This Is

A centralized **agent cron service center** that schedules, dispatches, monitors, and traces AI agent tasks across all managed projects. It provides:

- **Cron-based scheduling** — define when agents run (traditional xxl-job model)
- **On-demand triggering** — projects can call an API to trigger agent execution programmatically
- **Agent-to-agent triggering** — agents can trigger other agents, forming chains with depth limits and dedup
- **Agent registry** — all agents across all projects are visible in one place
- **Execution history** — every run is logged with status, duration, and result
- **LLM trace viewer** — for LLM agents, every model call is captured: prompt → response, tool calls, tokens, latency
- **Real-time monitoring** — WebSocket-driven live dashboard showing what's running right now
- **Alerting** — configurable rules for failures, timeouts, queue depth, and cost anomalies

### 1.2 What This Is NOT

- **Not a workflow/DAG engine** (use Temporal/Airflow for that)
- **Not an agent execution framework** (agents execute in their own projects)
- **Not a replacement for LangFuse/LangSmith** (we capture traces, but evaluation/prompt management is out of scope)

### 1.3 Inspired By

| Source | What We Borrow |
|--------|---------------|
| **xxl-job** | Admin + Executor architecture, cron management, execution logging, manual trigger, misfire policy |
| **Temporal** | Task Queue concept, Event Sourcing for execution state, heartbeat with payload, child workflow ID dedup |
| **Prefect** | Work Pool pattern, rich state machine, decorator-based SDK, `wait_for` semantics |
| **LangFuse** | Trace → Observation data model, nested LLM call capture |
| **River (Go)** / **Asynq** | JobArgs+Worker pairing, ServeMux handler registration, LISTEN/NOTIFY, PG advisory locks for leader election |
| **Airflow** | Grid View, `TriggerDagRunOperator` with `wait_for_completion` flag, pool/slot concurrency model |

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
│              │  (projects, agents, executions, traces,      ││
│              │   cooldowns, alert_log)                      ││
│              └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
          ▲                ▲                ▲
          │ HTTP/Pull      │ HTTP/Push      │ HTTP/Pull
          │                │ (HMAC signed)  │
    ┌─────┴─────┐    ┌─────┴─────┐    ┌─────┴─────┐
    │ llm-wiki   │    │    OPH    │    │  future   │
    │ (TS SDK)   │    │ (Go SDK)  │    │ projects  │
    └───────────┘    └───────────┘    └───────────┘
```

### 2.2 Key Design Decisions

**D1: Agent Hub is the scheduling authority.** Projects no longer run their own scheduler loops. Agent Hub owns cron evaluation, job creation, and dispatch. Projects become pure executors.

**D2: Pull-first communication.** Executors long-poll Agent Hub for pending work (penetrates NATs/firewalls). Push (HTTP callback) is secondary, HMAC-signed, for executors with stable, reachable endpoints.

**D3: PostgreSQL as the single source of truth.** No Redis, no message broker. One database for everything: agent registry, execution state, LLM traces, cooldown state. Simplifies deployment and operations. This is the River/Prefect pattern.

**D4: SDK does the heavy instrumentation.** The SDK auto-captures LLM calls, manages heartbeats, and reports progress. Projects don't write tracing code — they call `ctx.llm.chat()` and tracing happens automatically.

**D5: Agents can trigger agents.** An agent handler can call `ctx.trigger()` to fire another agent. This enables decomposition of monolithic loops like OPH's steward. Trigger chains have depth limits and idempotency keys to prevent runaway cascades.

**D6: Progressive migration.** Old and new hubs run side-by-side during transition. Projects migrate one agent at a time. No big-bang cutover.

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
| **Dashboard Auth** | HTTP Basic Auth (simple password) | Minimum viable; upgrade to JWT in Phase 5 |
| **Health/Metrics** | `GET /api/health` + `GET /api/metrics` | Essential for load balancer, monitoring |
| **Password Hashing** | `bcrypt` or built-in `crypto.scrypt` | Dashboard password storage |
| **Go SDK** | Custom, referencing River/Asynq patterns | Thin HTTP client + handler registry |
| **Python SDK** | Custom, referencing Celery patterns | Thin HTTP client + decorator-based registration |
| **TypeScript SDK** | Custom, referencing pg-boss patterns | Thin HTTP client + handler registry |

**Libraries explicitly NOT used (and why):**

| Library | Why Not |
|---------|---------|
| `pg-boss` | Designed for workers connecting to same PG — our executors are remote HTTP clients. |
| `bullmq` | Requires Redis. We use PG-only. |
| `temporal` | Overkill — workflow orchestration, not cron scheduling. See Section 14 for migration criteria. |
| `celery` | Python-only, requires broker. Our executors are multi-language HTTP clients. |
| `langfuse` | Full observability platform with ClickHouse — too heavy. We only need the trace data model. |

---

## 3. Data Model

### 3.1 Entity Relationship

```
Project (1) ────< Agent (N) ────< Execution (N) ────< Trace (N)
                         │
                         └── parent_execution_id / root_execution_id / trigger_depth
                             (execution-to-execution chain for agent-to-agent triggers)
```

### 3.2 Tables

#### `projects`

```sql
CREATE TABLE projects (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL UNIQUE,
  display_name            TEXT NOT NULL,
  description             TEXT,
  workspace_path          TEXT,
  status                  TEXT NOT NULL DEFAULT 'active', -- active | inactive | archived
  api_key_hash            TEXT,        -- SHA-256 hashed API key for SDK auth
  dashboard_password_hash TEXT,        -- bcrypt hashed password for dashboard access
  allow_trigger_from      TEXT[] DEFAULT '{}',  -- projects allowed to trigger this project's agents
  trigger_rate_limit_per_sec INTEGER DEFAULT 50, -- global rate limit for API triggers
  cost_config             JSONB DEFAULT '{}',    -- per-project pricing overrides
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `agents`

```sql
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,               -- unique within project
  display_name    TEXT NOT NULL,
  description     TEXT,
  agent_type      TEXT NOT NULL,               -- 'cron_task' | 'llm_agent'

  -- Scheduling
  cron_expression TEXT,                         -- NULL = manual/API trigger only
  enabled         BOOLEAN NOT NULL DEFAULT true,
  misfire_policy  TEXT NOT NULL DEFAULT 'fire_once',
                    -- 'fire_once': skip missed windows, fire once at next tick (xxl-job default)
                    -- 'fire_all':   fire for every missed cron window (catch-up)
                    -- 'drop':       skip all missed windows, wait for next scheduled time
  concurrency     INTEGER NOT NULL DEFAULT 1,   -- max parallel running executions
  max_pending_queue INTEGER NOT NULL DEFAULT 100, -- max queued + running; 429 if exceeded
  timeout_seconds INTEGER NOT NULL DEFAULT 600,
  retry_max       INTEGER NOT NULL DEFAULT 3,
  retry_backoff_base_ms INTEGER NOT NULL DEFAULT 30000,

  -- Safety guards (agent_loop / ReAct agents)
  max_turns       INTEGER,                     -- max ReAct loop turns before auto-cancel
  max_cost_usd    NUMERIC(10,6),               -- max total LLM cost per execution

  -- Handler routing
  handler_name    TEXT,

  -- Executor discovery
  executor_host   TEXT,                         -- SDK registers this on startup
  executor_status TEXT NOT NULL DEFAULT 'offline', -- online | offline | degraded

  -- Input validation
  input_schema    JSONB,

  -- Trigger authorization
  allow_trigger_by JSONB,   -- NULL = any agent in same project can trigger (default)
                             -- NOT NULL = whitelist: {"projects": ["oph"], "agents": ["steward_backlog"]}
                             -- {"projects": [], "agents": []} = no agent can trigger (manual/API only)

  -- Idempotency
  idempotency_window_seconds INTEGER NOT NULL DEFAULT 3600,  -- 1 hour

  -- Labels
  labels          JSONB DEFAULT '{}',

  -- Heartbeat
  last_heartbeat_at TIMESTAMPTZ,
  last_execution_at TIMESTAMPTZ,
  active_execution_count INTEGER NOT NULL DEFAULT 0, -- atomically maintained counter

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

Note: `agent_loop` was considered but removed. Long-running loops (like OPH steward) decompose into individual cron agents (one per check) with agent-to-agent triggering. Individual checks that currently run in a 60s tick become their own agents with natural cadences (every minute, every 30 minutes, daily). This provides better visibility and independent control. Truly continuous workloads (file watchers, message queue consumers) remain as custom processes with `trigger_type='api'`.

#### `executions`

```sql
CREATE TYPE trigger_type AS ENUM ('cron', 'manual', 'api', 'agent', 'retry');
CREATE TYPE execution_status AS ENUM (
  'queued', 'running', 'success', 'failed', 'timeout', 'cancelled'
);

CREATE TABLE executions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- Trigger info
  trigger_type    trigger_type NOT NULL,
  triggered_by    TEXT,            -- 'cron', 'user:emo', 'api:oph-steward', 'agent:steward_backlog'

  -- Agent-to-agent trigger chain (Temporal child workflow pattern)
  parent_execution_id UUID REFERENCES executions(id),  -- who triggered me
  root_execution_id   UUID REFERENCES executions(id),  -- ultimate root of this chain
  trigger_depth       INTEGER NOT NULL DEFAULT 0,

  -- Idempotency (Prefect/Stripe pattern)
  idempotency_key TEXT,                         -- unique within agent + time window

  -- Status
  status          execution_status NOT NULL DEFAULT 'queued',

  -- Timing
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,

  -- Last activity (for stuck-vs-slow diagnosis)
  last_activity_at TIMESTAMPTZ,                 -- updated on each trace write or heartbeat

  -- Result
  input_payload   JSONB,
  result_summary  TEXT,
  result_data     JSONB,
  error_message   TEXT,
  error_stack     TEXT,

  -- Trace completeness
  trace_count_expected INTEGER,    -- set by SDK on report (final count); NULL during execution
  trace_count_actual   INTEGER DEFAULT 0,  -- incremented with each trace batch; live during execution
  trace_incomplete     BOOLEAN DEFAULT false,  -- set by hub on report if actual < expected

  -- Retry
  retry_count     INTEGER NOT NULL DEFAULT 0,
  retry_of        UUID REFERENCES executions(id),

  -- Executor info
  executor_host   TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_executions_agent ON executions(agent_id);
CREATE INDEX idx_executions_status ON executions(status);
CREATE INDEX idx_executions_scheduled ON executions(scheduled_at);
CREATE INDEX idx_executions_created ON executions(created_at DESC);
CREATE INDEX idx_executions_agent_status ON executions(agent_id, status);
CREATE INDEX idx_executions_parent ON executions(parent_execution_id);
CREATE INDEX idx_executions_root ON executions(root_execution_id);
CREATE UNIQUE INDEX idx_executions_idempotency
  ON executions(agent_id, idempotency_key)
  WHERE status IN ('queued', 'running') AND idempotency_key IS NOT NULL;
```

#### `traces`

```sql
CREATE TYPE trace_role AS ENUM ('system', 'user', 'assistant', 'tool');

CREATE TABLE traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,

  -- Ordering within execution
  turn_index      INTEGER NOT NULL,
  span_index      INTEGER NOT NULL DEFAULT 0,
  parent_span_id  UUID REFERENCES traces(id),

  -- Role & Type
  role            trace_role NOT NULL,
  span_type       TEXT NOT NULL DEFAULT 'llm',  -- 'llm' | 'tool_call' | 'tool_result' | 'custom'

  -- Model info (for LLM spans)
  model           TEXT,
  provider        TEXT,

  -- Content (TOAST-compressed by PostgreSQL automatically for rows >2KB)
  input_content   TEXT,
  output_content  TEXT,
  tool_calls      JSONB,
  tool_results    JSONB,

  -- Metrics
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_estimate   NUMERIC(10,6),               -- hub-computed from pricing table
  latency_ms      INTEGER,

  -- Metadata
  metadata        JSONB DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traces_execution ON traces(execution_id);
CREATE INDEX idx_traces_turn ON traces(execution_id, turn_index);
CREATE INDEX idx_traces_parent ON traces(parent_span_id);
```

#### `agent_cooldowns` (DB-backed cooldown state, survives restarts)

```sql
CREATE TABLE agent_cooldowns (
  agent_name    TEXT NOT NULL,
  cooldown_key  TEXT NOT NULL,                  -- e.g., 'signal_detection', 'trend_generation'
  last_run_at   TIMESTAMPTZ NOT NULL,
  run_count     INTEGER DEFAULT 0,
  PRIMARY KEY (agent_name, cooldown_key)
);
```

Used by evaluator agents (steward checks) to persist cooldown state across restarts. Replaces volatile in-memory `time.Time` fields. Each evaluator checks cooldown state before running and upserts after completing.

**Orphan handling:** `agent_name` is a TEXT reference, not a UUID FK, because agents are identified by `(project_id, name)` — a composite FK is disproportionate for a helper table. If an agent is renamed or deleted, orphan cooldown rows are harmless dead state. `RetentionCleanup` purges cooldown rows with `last_run_at < now() - INTERVAL '90 days'` on its daily run.

**Access pattern:** Cooldowns are read and written by agent handler code (running in the executor/SDK process), not by the hub. The SDK exposes this via `ctx.cooldowns.get(key)` and `ctx.cooldowns.set(key)`. Under the hood, these call `GET /api/cooldowns/:agent_name/:key` and `PUT /api/cooldowns/:agent_name/:key`. The hub validates that the authenticated project matches the agent name prefix.

#### `alert_log`

```sql
CREATE TABLE alert_log (
  id          BIGSERIAL PRIMARY KEY,
  rule_name   TEXT NOT NULL,                    -- 'agent_offline', 'failure_rate_spike', etc.
  severity    TEXT NOT NULL,                    -- 'critical' | 'warning' | 'info'
  agent_id    UUID REFERENCES agents(id),
  message     TEXT NOT NULL,
  context     JSONB,                            -- relevant execution IDs, counts, etc.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_log_created ON alert_log(created_at DESC);
```

### 3.3 Writes Pattern — Append-Only Trace Storage

Following the LangFuse pattern: traces are written **during execution**, not in a batch at the end. Each `ctx.llm.chat()` call immediately POSTs a trace row to the hub. This means:
- Traces are visible in the dashboard in real-time (before execution completes)
- If the execution crashes mid-way, partial traces are preserved
- The SDK batches trace inserts (configurable batch size, default 10, flush interval 2s) to reduce HTTP overhead

**Trace count semantics:** `trace_count_actual` is incremented with each trace batch, serving as a live counter during execution — the dashboard shows "12 traces recorded so far." `trace_count_expected` is NULL during execution and set by the SDK only at report time, when the handler knows the final count. For dynamic agents (ReAct loops with variable turns), the expected count is inherently unknown until completion — this is normal, not an error. After report, the hub computes `trace_incomplete = (expected != actual)`. If the SDK crashes before reporting, `trace_count_expected` stays NULL and `trace_incomplete` stays false — the dashboard shows the actual count without declaring completeness.

### 3.4 Cleanup / Retention

| Table | Default Retention | Configurable |
|-------|------------------|--------------|
| `executions` | 90 days | `AGENT_HUB_EXECUTION_RETENTION_DAYS` |
| `traces` | 30 days | `AGENT_HUB_TRACE_RETENTION_DAYS` |
| `alert_log` | 180 days | `AGENT_HUB_ALERT_RETENTION_DAYS` |

A background maintenance job purges expired rows daily. Deletion is batched (LIMIT 10000 per iteration with short pauses) to avoid long-running transactions locking the tables.

### 3.5 Content Compression

Trace `input_content` and `output_content` are TEXT columns. PostgreSQL applies TOAST compression (pglz by default, lz4 on PG 14+) automatically for rows exceeding ~2KB, giving 2-4x compression. Estimated steady-state DB size for 20 agents at 30-day retention: **~8-10 GB**. If agent count doubles or retention extends to 90 days, consider truncating content to a configurable max length (e.g., 100KB) with full content stored in object storage (S3/MinIO) referenced by hash.

### 3.6 Cost Tracking

The hub maintains a `provider_pricing` table:

```sql
CREATE TABLE provider_pricing (
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  input_cost_per_1k     NUMERIC(10,6) NOT NULL,
  output_cost_per_1k    NUMERIC(10,6) NOT NULL,
  effective_from        DATE NOT NULL,
  PRIMARY KEY (provider, model, effective_from)
);
```

The hub computes `cost_estimate` on trace insert as: `(input_tokens * input_cost_per_1k + output_tokens * output_cost_per_1k) / 1000`. Projects can override prices via `projects.cost_config` for internal/custom models (e.g., leihuo proxy).

---

## 4. Scheduling Engine

### 4.1 Internal Architecture

The scheduler runs inside the Fastify server process. It uses a cron-evaluation loop + PostgreSQL-based dispatch with `SELECT ... FOR UPDATE SKIP LOCKED` for concurrency-safe claim semantics. The tick interval is 1 second (configurable via `AGENT_HUB_SCHEDULER_TICK_MS`).

**Tick error isolation:** Every step in the scheduler tick is independently wrapped in try/catch. A failure in one step (e.g., CronEvaluator hits a PG timeout) does not prevent other steps from running. Matcher dispatch and HeartbeatMonitor must always execute, regardless of upstream failures.

```
for each tick:
  try { CronEvaluator.run() }    catch → log error, continue
  try { HeartbeatMonitor.run() } catch → log error, continue
  try { TimeoutChecker.run() }   catch → log error, continue
  try { RetryManager.run() }     catch → log error, continue
  try { RetentionCleanup.run() } catch → log error, continue
  try { AlertEvaluator.run() }   catch → log error, continue
  Matcher.run()  // all instances, no lock; always runs
```

Each step logs failures at `ERROR` level with full stack trace. The tick loop itself never crashes.

**The scheduler is split into two tiers:**

- **Leader-only components** (protected by advisory lock): Only the Leader instance runs these. They make scheduling *decisions* (create executions, detect failures, evaluate alerts).
- **All-instances components** (no lock needed): Every instance runs these. They handle *dispatch* to executors via long-poll or push.

```
Leader-only (one instance holds pg_try_advisory_lock):
│
├── 1. CronEvaluator
│     SELECT * FROM agents WHERE enabled=true AND cron_expression IS NOT NULL
│     For each agent:
│       croner.nextRun(cron_expression, last_execution_at) <= now()
│       → Compute pending: COUNT(*) FROM executions WHERE agent_id=$id
│         AND status IN ('queued','running')
│       → If pending >= max_pending_queue: log warning, skip this cycle
│         (queue is full; executions will catch up naturally or timeout)
│       → Apply misfire_policy, capped by (max_pending_queue - pending):
│         'fire_once': create 1 execution (respecting cap)
│         'fire_all':  create up to (max_pending_queue - pending) executions
│                      for missed windows; drop excess windows
│         'drop':      skip all; wait for next natural trigger time
│       → INSERT INTO executions (agent_id, trigger_type='cron', status='queued')
│       → UPDATE agents SET last_execution_at = now()
│
│     max_pending_queue ensures a 12-hour downtime of a * * * * * agent
│     produces at most 100 queued executions, not 720.
├── 2. HeartbeatMonitor
│     SELECT * FROM agents WHERE executor_status='online'
│       AND last_heartbeat_at < now() - INTERVAL '30 seconds'
│     → UPDATE SET executor_status = 'offline'
│     → Cancel running executions for this agent
│
├── 3. TimeoutChecker
│     SELECT * FROM executions WHERE status='running'
│       AND started_at + (agent.timeout_seconds * INTERVAL '1 second') < now()
│     → UPDATE SET status='timeout', finished_at=now()
│     → UPDATE agents SET active_execution_count = active_execution_count - 1
│
├── 4. RetryManager
│     SELECT * FROM executions WHERE status IN ('failed','timeout')
│       AND retry_count < agent.retry_max
│       AND finished_at + (backoff_delay * INTERVAL '1 ms') < now()
│     → INSERT new execution (retry_of=original.id, retry_count=original.retry_count+1)
│     backoff_delay = min(retry_backoff_base_ms * 2^retry_count, 600000)
│
├── 5. RetentionCleanup (daily)
│     DELETE FROM traces WHERE created_at < now() - INTERVAL '30 days'
│       LIMIT 10000; (repeat with pauses)
│
└── 6. AlertEvaluator (every 10 seconds)
      Evaluates alerting rules (Section 13), inserts alert_log rows,
      broadcasts critical alerts via WebSocket.

All-instances (every instance, independently):
│
└── 7. Matcher (dispatch queued → running when executor is available)
      -- Only claim executions for agents that have a local long-poll waiter
      -- OR have executor_host set (push mode). This prevents orphan executions
      -- where Instance A claims work that only Instance B has a waiter for.
      SELECT e.* FROM executions e
      JOIN agents a ON e.agent_id = a.id
      WHERE e.status = 'queued'
        AND a.executor_status = 'online'
        AND a.active_execution_count < a.concurrency
        AND (
          e.agent_id IN (<local_waiter_agent_ids>)
          OR a.executor_host IS NOT NULL
        )
      ORDER BY e.scheduled_at ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
      
      For each matched execution:
        → UPDATE agents SET active_execution_count = active_execution_count + 1
        → If local waiter exists: resolve the Deferred (sends execution to SDK)
        → Else if executor_host is set: POST (HMAC-signed, Section 4.4)
        → UPDATE execution SET status='running', started_at=now()
```

**Why Matcher doesn't need the leader lock:** `SELECT ... FOR UPDATE SKIP LOCKED` already provides concurrency safety — two instances competing for the same rows will never claim the same execution. The `active_execution_count` increment is a simple atomic `UPDATE ... SET count = count + 1`. No leader coordination is needed for dispatch.

**Multi-instance dispatch semantics:** An execution is only claimed by an instance that either (a) has a local long-poll waiter for that agent, or (b) can push to the agent's `executor_host`. Without the local-waiter check, Instance A could claim a `queued` execution for agent X while only Instance B has an SDK connected for X — producing an orphan execution stuck in `running` until timeout. The `local_waiter_agent_ids` filter prevents this.

**v1 note:** Phase 1-4 runs single-instance, where every waiter is local and this condition is always true. The local-waiter check becomes critical only in Phase 5 multi-instance deployment.

### 4.2 Startup Recovery

On hub startup (before the scheduler tick loop begins), the hub runs a compensation query to align `active_execution_count` with reality:

```sql
-- Compensate for any counter drift from unclean shutdown
UPDATE agents SET active_execution_count = (
  SELECT COUNT(*) FROM executions
  WHERE executions.agent_id = agents.id
    AND executions.status = 'running'
);
```

This handles the crash-recovery scenario: if the hub crashed with `active_execution_count = 3` but one executor subsequently completed and another crashed, the compensation query resets the count to the actual number of `running` rows in the database.

**Executions that were `running` at crash time are NOT immediately failed.** They remain `running` and enter a recovery window:
- If the executor is still alive, its next heartbeat (within 10s) keeps `executor_status = 'online'`, and its next report call completes the execution normally
- If the executor died, `HeartbeatMonitor` detects the missed heartbeat after 30s, marks the executor offline, cancels the executions, and zeros the counter

**Max recovery window: 30 seconds** from hub startup. During this window, `active_execution_count` may be non-zero for agents whose executors are dead, causing the Matcher to skip them. This is acceptable: execution SLAs are minutes to hours, and running the compensation query at startup bounds the window to a single HeartbeatMonitor cycle. No permanent scheduling blockage.

### 4.3 Long-Poll Dispatch (Pull Mode)

The primary dispatch mechanism. Executors call `GET /api/executors/poll` with their agent names. The server holds the connection open (up to 30s). When a matching execution is queued, it returns immediately. If no execution is available within the timeout, it returns `204 No Content` and the executor re-polls.

**Why long-poll:** NAT-friendly, no firewall issues, simple HTTP (no gRPC needed), works with standard HTTP clients in all languages.

**Library reference:** This is the same pattern used by Temporal's `PollWorkflowTaskQueue` and Prefect's worker polling. Implementation uses a `Map<agentId, Deferred[]>` in the server — when the Matcher finds a queued execution, it resolves the oldest pending long-poll request for that agent.

### 4.4 Push Dispatch (Callback)

Secondary mechanism. If an agent's `executor_host` is set and reachable, the hub POSTs to `http://{executor_host}/agent-hub/execute` with the execution payload. **Push requests are HMAC-signed** using a shared secret derived from the project API key (`HMAC-SHA256(api_key, execution_id + timestamp)`). The SDK verifies this signature before executing to prevent injection of fake executions.

### 4.5 Leader Election (for HA)

When running multiple hub instances, the Leader lock protects only **scheduling decisions** (CronEvaluator, HeartbeatMonitor, TimeoutChecker, RetryManager, RetentionCleanup, AlertEvaluator). Dispatch (Matcher) runs on all instances without the lock.

Leader election uses PostgreSQL advisory locks, following the River pattern:

```sql
-- Non-blocking try-lock with namespaced key (avoids collision)
SELECT pg_try_advisory_lock(hashtext('agent_hub_scheduler'));
```

The instance that holds the lock runs the Leader-only components. If the instance crashes, the lock is released by PostgreSQL when the connection drops, and another instance acquires it. No external coordinator needed.

**Failover behavior:** When Leader crashes:
- Scheduling pauses briefly (one tick at most — the next instance acquires the lock on its next tick attempt)
- Dispatch continues uninterrupted on surviving instances
- SDKs connected to the dead instance get a connection error and reconnect to another URL from `serverUrls`
- The new Leader re-evaluates cron state from PostgreSQL (no in-memory state for scheduling decisions)

**SDK serverUrls semantics:**
- SDK accepts `serverUrls: ['http://hub1:8787', 'http://hub2:8787']`
- On each poll attempt (including after a successful poll or a connection error), the SDK **randomly selects** a URL from the list
- No sticky preference — this naturally distributes load and avoids all SDKs piling onto the dead Leader
- The SDK does NOT need to know which instance is Leader — any instance can dispatch work

**Instance symmetry:** All hub instances are identical. They all run the same code, expose the same API, and participate in dispatch. The only difference is which one holds the advisory lock at any moment. This is the same model as River's leader election.

### 4.6 Scale Boundaries & Target

This design is validated for:
- **Up to 100 agents** across ~5 projects
- **Up to 1000 executions/day**
- **Up to 10 concurrent running executions**
- **Up to 50,000 traces/day**
- **30-day trace retention, ~10 GB DB**

For scale beyond this, or for multi-step workflow orchestration (3+ sequential steps), see Section 14 for Temporal migration criteria.

---

## 5. SDK Design

### 5.1 Common SDK Layers

All three language SDKs (TypeScript, Go, Python) provide the same four-layer API:

```
Layer 1: Registration      — register agent spec with the hub
Layer 2: Execution         — pull jobs, execute handlers, heartbeat, report results
Layer 3: Instrumentation   — auto-capture LLM traces
Layer 4: Agent Triggering  — trigger other agents with dedup and depth control
```

### 5.2 TypeScript SDK

**Package:** `@agent-hub/sdk`

**Dependencies:** zero required (uses built-in `fetch` in Node 20+), optional `@anthropic-ai/sdk` / `openai` for auto-instrumentation.

```typescript
import { AgentHubClient } from '@agent-hub/sdk';

const hub = new AgentHubClient({
  serverUrl: 'http://agent-hub.internal:8787',
  // For HA: serverUrls: ['http://hub1:8787', 'http://hub2:8787'],
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

// Layer 2: Define handler — receives cancellation signal via ctx.signal (AbortSignal)
hub.handle('llm_extract_handler', async (ctx) => {
  // Check for cancellation (from timeout or operator cancel)
  if (ctx.signal.aborted) return { cancelled: true };

  await ctx.log('Starting extraction...');
  await ctx.progress(0.3, 'Fetching source...');

  // Layer 3: LLM call — auto-traced
  const response = await ctx.llm.chat({
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'Extract structured knowledge from the source.' },
      { role: 'user', content: ctx.payload.source_text },
    ],
    signal: ctx.signal,  // propagates cancellation to LLM call
  });

  // Layer 4: Trigger another agent (fire-and-forget by default)
  await ctx.trigger('sync_wiki', {
    payload: { source_id: ctx.payload.source_id },
    idempotencyKey: `extract-sync-${ctx.payload.source_id}`,
  });

  // Or trigger multiple agents with concurrency control
  const results = await ctx.triggerBatch(
    sources.map(s => ({
      agent: 'llm_extract',
      payload: { source_id: s.id },
      idempotencyKey: `batch-extract-${s.id}`,
    })),
    { concurrency: 5 }
  );

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

await hub.start();
```

**Cancellation signal:** Every handler receives `ctx.signal` (an `AbortSignal`). The SDK creates an `AbortController` and aborts it when:
- The handler exceeds `timeout_seconds` (SDK-enforced, independent of hub TimeoutChecker)
- The hub sends a cancel signal (poll returns `{type: 'cancel', execution_id: '...'}`)

After aborting, the SDK waits a grace period (5s), then force-terminates and reports `failed` with `error_message: 'Force-terminated after timeout/cancel'`.

**Version header:** Every SDK request includes `Agent-Hub-Version: 1`. The hub responds with the same header. If the hub returns a higher major version, the SDK warns but continues. If a lower major version, the SDK errors on startup. API changes within a major version are additive-only (new fields optional, new endpoints additive).

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

func handleDeepResearch(ctx agenthub.Context, job *agenthub.Job) error {
    ctx.Log("Starting deep research on %s", job.Payload["repo_name"])

    // Check for cancellation
    select {
    case <-ctx.Done():
        return ctx.Done().Err()
    default:
    }

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

    // Trigger another agent
    ctx.Trigger("enrich_repo", agenthub.TriggerOpts{
        Payload:         map[string]interface{}{"repo_id": job.Payload["repo_id"]},
        IdempotencyKey:  fmt.Sprintf("research-enrich-%s", job.Payload["repo_id"]),
    })

    return ctx.Report(agenthub.Result{Summary: "Research completed", Data: resp.Content})
}

func main() {
    client := agenthub.NewClient(agenthub.Config{
        ServerURL: os.Getenv("AGENT_HUB_URL"),
        Project:   "oph",
        APIKey:    os.Getenv("AGENT_HUB_API_KEY"),
    })

    client.Register(agenthub.AgentSpec{
        Name:        "deep_research",
        DisplayName: "Deep Research",
        AgentType:   agenthub.AgentTypeLLM,
        Cron:        "0 */2 * * *",
        Handler:     "deep_research_handler",
        Concurrency: 3,
        TimeoutSecs: 600,
        RetryMax:    2,
    })

    mux := agenthub.NewServeMux()
    mux.HandleFunc("deep_research_handler", handleDeepResearch)

    // Run blocks, pulling jobs via long-poll
    client.Run(context.Background(), mux)
}
```

**Panic recovery:** The `ServeMux` dispatcher recovers panics via `defer/recover`, converts to an error result, and reports execution as `failed` with `error_message` from the panic and `error_stack` from `debug.Stack()`.

### 5.4 Python SDK

**Package:** `agent-hub-sdk` (PyPI)

**Dependencies:** `httpx` (async HTTP), optional `openai` / `anthropic` for auto-instrumentation.

```python
from agent_hub_sdk import AgentHubClient, agent
import asyncio

hub = AgentHubClient(
    server_url="http://agent-hub.internal:8787",
    project="llm-wiki",
    api_key=os.environ["AGENT_HUB_API_KEY"],
)

@agent(
    name="llm_synthesize",
    display_name="LLM Synthesis",
    agent_type="llm_agent",
    cron="0 0 */2 * *",
    concurrency=1,
    timeout_seconds=600,
    retry_max=2,
)
async def llm_synthesize(ctx):
    await ctx.log("Starting synthesis...")

    # ctx.cancelled is an asyncio.Event set on timeout/cancel
    if ctx.cancelled.is_set():
        return {"cancelled": True}

    response = await ctx.llm.chat(
        model="deepseek-v4-pro",
        messages=[
            {"role": "system", "content": "Synthesize findings from multiple sources."},
            {"role": "user", "content": ctx.payload["combined_text"]},
        ],
    )

    # Trigger downstream agent
    await ctx.trigger("sync_wiki", payload={"source": ctx.payload["source"]})

    return {"synthesis": response.content}

await hub.start()
```

### 5.5 SDK-Hub Protocol

All SDKs communicate with the hub over HTTP. All requests include `Agent-Hub-Version: 1` header.

| Endpoint | Method | Purpose | Called By |
|----------|--------|---------|-----------|
| `/api/registry/agents` | PUT | Register/update agent spec | SDK on startup |
| `/api/registry/agents/:name` | DELETE | Deregister an agent | SDK on shutdown |
| `/api/executors/heartbeat` | POST | Send heartbeat with progress for running executions | SDK every 10s |
| `/api/executors/poll` | GET | Long-poll for pending executions (30s timeout) | SDK in pull loop |
| `/api/executions/:id/report` | POST | Report execution result + trace_count_expected | SDK on completion |
| `/api/executions/:id/traces` | POST | Append trace records (batch, max 100 per request) | SDK during execution |
| `/api/cooldowns/:agent_name/:key` | GET | Read cooldown state for a key | SDK / agent handler |
| `/api/cooldowns/:agent_name/:key` | PUT | Upsert cooldown state (last_run_at, run_count) | SDK / agent handler |

**Authentication:** `Authorization: Bearer <api_key>` header on all requests. API key is SHA-256 hashed and stored in `projects.api_key_hash`.

**Error codes for SDK retry behavior:**

| Status | Meaning | SDK Behavior |
|--------|---------|-------------|
| `200/201` | Success | Process response |
| `204` | No pending work (poll) | Re-poll immediately |
| `400` | Bad request | Log error, do not retry |
| `401/403` | Auth failure | Log error, exit process |
| `409` | Conflict (e.g., trigger_depth exceeded) | Return error to caller |
| `429` | Rate limited | Retry with backoff |
| `503` | Hub unhealthy | Retry with backoff (1s, 2s, 4s...) |
| Connection error | Network down | Retry with backoff; heartbeat skips silently; poll retries |

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
│     On network error: skip silently    │
│     On 500: log warn, skip             │
│     (next heartbeat in 10s will retry) │
│                                        │
│  3. Main loop:                         │
│     Randomly select URL from serverUrls │
│     GET {url}/api/executors/poll        │
│     (long-poll, up to 30s timeout)     │
│                                        │
│     204 → re-poll immediately          │
│     200 → process execution            │
│     Connection error → random reselect │
│       URL from serverUrls, backoff     │
│       retry (1s, 2s, 4s... max 30s)   │
│                                        │
│     If execution received:             │
│     ├── Lookup handler by name         │
│     ├── Create AbortController/cancel  │
│     ├── Run handler with signal        │
│     │   └── (LLM calls auto-traced)    │
│     │   └── (ctx.trigger/triggerBatch) │
│     ├── On panic/throw: recover,       │
│     │   flush traces, report failed    │
│     ├── Flush trace batch              │
│     └── POST /api/executions/:id/report│
│         On network error: buffer       │
│         locally, retry on next poll    │
│                                        │
│  4. Graceful shutdown:                 │
│     - Stop pulling new jobs            │
│     - Signal cancellation to running   │
│       handlers, wait grace period (5s) │
│     - Flush remaining traces           │
│     - DELETE /api/registry/agents/:name│
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
| `POST` | `/api/executors/heartbeat` | Executor heartbeat + running execution progress |
| `POST` | `/api/executions/:id/report` | Report execution result |
| `POST` | `/api/executions/:id/traces` | Append trace records (batch) |
| `POST` | `/api/agents/:name/trigger` | Trigger an agent (full protocol in Section 8) |

### 6.2 Dashboard API (for React frontend)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (DB connectivity, scheduler status) |
| `GET` | `/api/metrics` | Prometheus-compatible metrics (queue depth, active execs, tick latency) |
| `GET` | `/api/projects` | List all projects with agent counts, health summary |
| `GET` | `/api/agents` | List agents with filters (project, type, status, labels) |
| `GET` | `/api/agents/:id` | Agent detail: stats, next run time, last 10 status dots |
| `GET` | `/api/agents/:id/schedule-preview` | Next N (default 10) expected run times |
| `PATCH` | `/api/agents/:id` | Update agent (enable/disable, change cron, concurrency) |
| `PATCH` | `/api/agents/bulk` | Bulk update agents (enable/disable by project, etc.) |
| `GET` | `/api/executors` | List all unique executor hosts with status, last seen |
| `GET` | `/api/executions` | Paginated execution list with filters |
| `GET` | `/api/executions/:id` | Execution detail (timing, result, traces summary) |
| `GET` | `/api/executions/:id/traces` | All traces for an execution (nested tree) |
| `GET` | `/api/executions/:id/trigger-chain` | Walk trigger chain up/down (recursive CTE) |
| `POST` | `/api/executions/:id/cancel` | Cancel a running execution |
| `GET` | `/api/stats` | Pre-aggregated stats (failure rate, avg latency, queue depth) |
| `GET` | `/api/alerts` | Recent alert log entries |
| `GET` | `/api/ws` | WebSocket upgrade for real-time updates |

### 6.3 WebSocket Events

```typescript
type WsEvent =
  | { type: 'agent.updated'; agent: Agent }
  | { type: 'execution.created'; execution: Execution }
  | { type: 'execution.updated'; execution: Execution }
  | { type: 'execution.triggered'; execution: Execution; triggeredBy: { executionId: string; agentName: string } }
  | { type: 'trace.appended'; executionId: string; trace: Trace; lastActivityAt: string }
  | { type: 'heartbeat.received'; agentId: string; progress?: ProgressUpdate }
  | { type: 'alert.fired'; alert: Alert }
  | { type: 'scheduler.tick'; stats: SchedulerStats };
```

### 6.4 Dashboard Authentication

Dashboard access requires HTTP Basic Auth. Password is hashed (bcrypt) and stored in `projects.dashboard_password_hash`. This is minimal but sufficient for the single-operator, internal-network deployment model. Upgrade path to JWT with role-based scopes in Phase 5.

Agent-to-agent trigger authorization: see Section 8.3.

---

## 7. Dashboard Design

### 7.1 Page Structure

```
Left Sidebar Navigation:
├── 📊 Overview        — aggregate stats, recent activity, health overview, active alerts
├── 🤖 Agents           — agent CRUD, cron management, status toggles, schedule preview
├── 📋 Executions       — execution history with filters, trigger chain drill-down
│   └── Execution Detail — timeline, LLM traces (expandable), logs
├── 📈 Analytics        — success rates, latency distributions, cost trends
├── 🔔 Alerts           — alert history, rule status
└── ⚙️ Settings         — projects, API keys, provider pricing, retention config
```

### 7.2 Key Views (from UI Research)

**Agents List** — reference: xxl-job task management + Argo cron dots

Shows: project, agent name, cron expression, enabled toggle, executor status, last 10 execution status dots (🟢 success, 🔴 failed, ⚪ no data, — disabled), next expected run time.

**Execution Detail** — reference: Temporal Timeline + LangFuse Trace Tree

Shows: status, duration, **last activity delta** ("last trace was 12s ago" — key for stuck-vs-slow diagnosis), trigger chain breadcrumb (cron → steward → deep_research), timeline with expandable LLM call spans (system prompt, user message, assistant response, tool calls with arguments and results).

**Trigger Chain View** — new, from agent-to-agent stress-test

Shows the full chain: root execution → intermediate agents → this execution, with status, duration, and expand/collapse. Uses `GET /api/executions/:id/trigger-chain?direction=both`.

**Executor Health** — connection status, last heartbeat, active executions, poll latency. Green/yellow/red indicators per executor.

### 7.3 Debugging Patterns (from operational stress-test)

| Operator Question | Where to Look |
|-------------------|--------------|
| "Did anything fail overnight?" | Overview → Failed stat card → filtered execution list |
| "Is it stuck or slow?" | Execution Detail → last activity delta; Timeline → most recent trace timestamp |
| "Why did X fire?" | Execution Detail → Trigger Chain breadcrumb |
| "Did my cron change take effect?" | Agent Detail → Next expected run time (computed live from `croner`) |
| "Why isn't agent picking up jobs?" | Executor Health → connection status, last heartbeat, poll latency |
| "Traces incomplete?" | Execution Detail → trace_count_expected vs trace_count_actual + `trace_incomplete` flag |

---

## 8. Agent-to-Agent Trigger Protocol

### 8.1 Trigger Request

```
POST /api/agents/:name/trigger
Authorization: Bearer <api_key>
Agent-Hub-Version: 1
Content-Type: application/json

{
  "payload": { ... },                    // JSONB, validated against agent.input_schema
  "idempotency_key": "unique-key",      // required for agent-to-agent triggers
  "dedup_policy": "skip_if_running"     // skip_if_running | skip_if_exists | allow_duplicate
}
```

### 8.2 Trigger Response

All triggers are **fire-and-forget** — the hub creates the execution and returns immediately. The HTTP connection is not held open. Callers that need to wait for the triggered execution to complete should poll `GET /api/executions/:id` from the SDK side.

```json
// 202 Accepted
{
  "execution_id": "uuid",
  "status": "queued",
  "duplicate": false
}

// 200 OK (duplicate — idempotency key matched existing execution)
{
  "execution_id": "uuid",
  "status": "running",
  "duplicate": true
}
```

**Design rationale:** Blocking sync (`sync: true`) was considered but rejected for v1. Holding HTTP connections open for up to 300 seconds is incompatible with L4/L7 load balancers (default idle timeout 60s) and adds in-memory state on the hub that is lost on restart. The value is also questionable for the current use cases — all existing agent-to-agent triggers (steward → deep_research, ingest → llm_extract) are naturally fire-and-forget: results are stored in the project's own blob store or filesystem, not passed inline to the caller. If a future use case genuinely requires blocking semantics, the SDK can implement client-side polling without any hub changes.

### 8.3 Trigger Authorization

Authorization is checked in order. A trigger is rejected at the first failing check.

```
1. API key → resolve caller project_id
2. Resolve target agent by name
3. Same-project check:
   a. If target_agent.project_id == caller.project_id:
      - allow_trigger_by is NULL      → allowed (default: any agent in same project)
      - allow_trigger_by restricts    → check agent/project whitelist
   b. If target_agent.project_id != caller.project_id (cross-project):
      - target_project.allow_trigger_from must include caller.project_id
      - target_agent.allow_trigger_by must explicitly list caller
        (NULL is NOT sufficient for cross-project — it only grants
         same-project access. Cross-project always requires an explicit
         agent-level whitelist entry.)
4. System agents (name prefixed '_hub_') → always rejected (409)
```

**Key semantic:** `allow_trigger_by = NULL` means "any agent in my project." It does NOT grant cross-project access. If project `oph` wants agent `llm_extract` to be triggerable by project `external`, both conditions must be met: `llm-wiki.allow_trigger_from` includes `'oph'`, AND `llm_extract.allow_trigger_by` explicitly lists `'oph/steward_backlog'` (or `'oph'` as project-level wildcard). This prevents the case where adding a project to `allow_trigger_from` unexpectedly opens access to all its agents.

System agents (names prefixed `_hub_`) cannot be triggered via the external API at all.

### 8.4 Trigger Depth Limit

Every execution has `trigger_depth`. When agent A triggers B, B's `trigger_depth = A.trigger_depth + 1`. The hub rejects triggers where `trigger_depth >= 5` (configurable via `AGENT_HUB_MAX_TRIGGER_DEPTH`). Response: `409 Conflict` with `{"error": "trigger_depth_exceeded", "max_depth": 5}`.

### 8.5 Idempotency & Dedup

Idempotency keys are scoped to (agent, key) pairs. The hub checks for existing `queued` or `running` executions with the same key within `agent.idempotency_window_seconds` (default 1 hour).

`dedup_policy` options:
- `skip_if_running` (default): Return existing if queued/running. Create new if only terminal executions exist.
- `skip_if_exists`: Return existing if ANY execution with this key exists (including success/failed). Only create if no execution has ever used this key.
- `allow_duplicate`: Always create new execution.

### 8.6 SDK Methods

```typescript
// Single trigger
await ctx.trigger('deep_research', {
  payload: { repo_id: '12345' },
  idempotency_key: `cadence-repo-12345-${today()}`,
});

// Batch trigger with concurrency control
await ctx.triggerBatch(
  repos.map(r => ({
    agent: 'discovery',
    payload: { repo_id: r.id },
    idempotency_key: `cadence-${r.id}-${today()}`,
  })),
  { concurrency: 5 }
);
```

### 8.7 Trigger Chain Data

When a trigger creates an execution, the hub distinguishes the source:

- **External API call** (no `X-Execution-ID` header): `trigger_type = 'api'`, no chain linkage
- **Agent-to-agent** (`X-Execution-ID` header present): `trigger_type = 'agent'`, chain linkage established

The hub sets the following fields on the new execution:

| Field | Source |
|-------|--------|
| `trigger_type` | `'agent'` if `X-Execution-ID` header present; `'api'` otherwise |
| `parent_execution_id` | Value of `X-Execution-ID` header (NULL for API triggers) |
| `root_execution_id` | Parent's `root_execution_id` ?? parent's `id` (NULL for API triggers) |
| `trigger_depth` | Parent's `trigger_depth + 1` (0 for API triggers) |
| `triggered_by` | `'agent:{parent_agent_name}'` or `'api:{project_name}'` |
| `idempotency_key` | From trigger request body |
| `input_payload` | From trigger request `payload` field |

**`X-Execution-ID` header validation chain:** The hub validates the header before establishing chain linkage. All checks must pass; the first failure returns an error response.

```
1. Execution exists:
   SELECT id, agent_id, project_id, status FROM executions WHERE id = $header_value
   → 404 if not found

2. Execution is in 'running' state:
   Only a running handler can trigger downstream agents.
   → 409 "trigger_from_terminal_execution" if status is 'success','failed','cancelled','timeout'

3. Execution belongs to the authenticated project:
   The API key's project_id must match the execution's project_id.
   → 403 "execution_not_owned" if mismatch
   (Prevents project P using project Q's execution_id to forge a trigger chain)

4. Target agent authorization (Section 8.3):
   Standard cross-project and allow_trigger_by checks apply.
   If the parent execution's agent has been granted access,
   the trigger proceeds.
```

**Why check #2 matters:** A handler reports `success` at the end of its execution. If the SDK sends a stray `ctx.trigger()` call after reporting, the execution is already terminal — the trigger is rejected. This prevents post-mortem chain extensions. The 409 response tells the SDK its trigger was dropped, which is logged as a warning.

**Why check #3 matters:** Without it, an attacker with a valid API key for project `malicious` could POST to `/api/agents/deep_research/trigger` with `X-Execution-ID: <some_oph_execution_id>` and make it appear as if OPH's steward triggered the deep_research. The project match check ensures the header's execution belongs to the same project as the API key.

The chain is traversable via `GET /api/executions/:id/trigger-chain?direction=up|down|both`, implemented as a recursive CTE on `parent_execution_id`.

---

## 9. Migration from Current agent-hub

### 9.1 Strategy: Progressive, Agent-by-Agent

Instead of big-bang removal, the old and new hub run side-by-side during transition:

1. Deploy new hub on a different port (e.g., 8788) with a blank PostgreSQL database
2. Old hub continues running on port 8787, unchanged
3. Register agents manually on the new hub via dashboard or `PUT /api/registry/agents`
4. Migrate one agent at a time:
   - Build SDK handler for the agent
   - Register agent spec on new hub (with desired cron)
   - Run in parallel with old execution for 2-3 days, compare results
   - Disable old cron/scheduler for that agent, enable new hub cron
5. Once all agents are migrated and stable, shut down the old hub
6. Old dashboard remains available (read-only) for historical reference during transition

### 9.2 What Gets Removed (after transition)

| Feature | Reason |
|---------|--------|
| Copilot/Claude/Gemini/OpenClaw session discovery | No longer local-only tool |
| Mock runtime / demo activity | Replaced by real agent registry |
| Runtime bridges (Copilot SDK, Claude resume, Gemini resume) | Agents execute via SDK |
| Inbox triage (acknowledge/snooze/mute) | Replaced by execution status management |
| Workspace actions (open in Finder/Terminal) | Out of scope |
| Reference catalog (curated GitHub projects) | Out of scope |

### 9.3 What Gets Kept (Repurposed)

| Feature | Repurposed As |
|---------|--------------|
| Fastify + WebSocket server | Core hub server (API + WS + scheduler) |
| React + Vite dashboard | New dashboard shell |
| `packages/shared` contracts | Redesigned for agents/executions/traces |
| `zod` validation patterns | API input validation |
| `examples/reference-sidecar.mjs` | Reference for TypeScript SDK usage |
| Drizzle ORM setup | Switch dialect from SQLite to PostgreSQL |

---

## 10. Implementation Phases

### Phase 1: Foundation (hub core)

- Clean up old code per Section 9.2
- Set up PostgreSQL + Drizzle ORM migrations (all tables from Section 3)
- Build scheduling engine (CronEvaluator with misfire support, Matcher, HeartbeatMonitor, TimeoutChecker, RetryManager)
- Hub API: agent registry, executor poll/heartbeat/report, health/metrics endpoints
- Dashboard auth (HTTP Basic)
- **Delivers:** Manual trigger from dashboard, zero SDK needed. Agents can be registered and triggered manually while old cron still runs.

### Phase 2: Go SDK + OPH Steward Decomposition

- Build `agent-hub-sdk-go` (minimal: register, poll, heartbeat, report, trigger)
- Decompose OPH steward into independent agents:
  - `steward_backlog_prioritize` (llm_agent, `* * * * *`) — checks backlog, LLM ranks, triggers `deep_research`
  - `steward_recover_stale` (cron_task, `* * * * *`) — re-queues stuck jobs
  - `steward_cadence_reentry` (cron_task, `*/30 * * * *`) — checks due repos, triggers discovery
  - `steward_scope_discovery` (cron_task, `0 0 * * *`) — regenerates discovery plans
  - `steward_lint` (cron_task, `0 3 * * *`) — daily lint checks
  - `steward_blob_retention` (cron_task, `0 4 * * *`) — cleans old blobs
  - `steward_re_enrichment` (cron_task, `0 5 * * *`) — finds un-enriched repos
  - `steward_signal_detection` (cron_task, `0 6 * * *`) — emits signal cards
  - `steward_trend_generation` (cron_task, `0 7 * * *`) — weekly/monthly trends
  - `steward_evidence_gaps` (cron_task, `0 */6 * * *`) — auto-heals relationships
- Required steward-side infrastructure (see Section 11):
  - DB-backed cooldowns (`agent_cooldowns` table)
  - Repo-level dedup key on deep_analysis job enqueue
  - LLM prioritization cooldown (separate from tick interval)
  - Lint orphan dedup check
  - Discovery cross-agent dedup query
- Migrate `deep_research`, `relationship_agent`, worker enrich stage
- **Delivers:** All OPH agents running through hub, steward fully decomposed

### Phase 3: Dashboard

- Agents List with cron management, status dots, schedule preview
- Execution history with filters and trigger chain drill-down
- Execution detail with timeline + LLM trace viewer
- Overview dashboard with stats, queue depth, connection health
- Executor health view
- Real-time WebSocket updates
- Alert history view
- **Delivers:** Full observability over all agents and executions

### Phase 4: Python SDK + llm-wiki Migration

- Build `agent-hub-sdk` (Python)
- Create evaluator agent: `channel_refresh_evaluator` (replaces `runAutomationTick`)
- Migrate llm-wiki agents one at a time:
  - `refresh_source_channel` — scrape channel, discover URLs
  - `ingest_source` — fetch and capture content
  - `llm_extract` — LLM extraction (auto-chained via `ctx.trigger` after ingest)
  - `llm_synthesize` — cross-source synthesis (manual/API trigger)
  - `sync_wiki` — re-index wiki pages
  - `discover_channels` — LLM-based channel discovery (manual)
- Remove `src/worker.ts`, `requeueJobForRetry` (hub owns retry)
- **Delivers:** All llm-wiki agents running through hub

### Phase 5: Production Hardening

- Multi-instance hub with leader election
- Provider pricing table seeding (DeepSeek, Claude, OpenAI)
- Alerting sinks (Slack webhook, email)
- API key management UI
- Retention cleanup automation
- Content truncation/compression policy if needed
- JWT dashboard auth (replace Basic Auth)

---

## 11. Steward Decomposition Reference

This section documents the specific patterns needed to safely decompose OPH's 60s steward loop into 10 independent cron agents. These patterns are reusable for any project decomposing a monolithic scheduler loop.

### 11.1 Required Infrastructure

1. **DB-backed cooldowns** (`agent_cooldowns` table): Replaces volatile `time.Time` fields in the old steward struct. Each evaluator agent checks `WHERE last_run_at < now() - cooldown_duration` and upserts after completing.

2. **Repo-level dedup key** on job enqueue (`dedupe_key TEXT` on the OPH job queue): `deep_analysis:{owner}/{repo}`. Before enqueuing, check `WHERE dedupe_key = $1 AND status IN ('queued','running') AND requested_at > now() - INTERVAL '6 hours'`. Prevents same-repo double-enqueue from different agents.

3. **LLM prioritization cooldown** (10 minutes, separate from tick interval): `steward_backlog_prioritize` only calls the LLM prioritizer when `len(candidates) > availableSlots * 3` AND at least 10 minutes since last LLM prioritization call. Otherwise uses FIFO.

4. **Cross-agent discovery dedup**: Before enqueuing `StageDiscovery`, check if any active discovery run already covers the same policy/trigger ref.

5. **Shared event log via `result_data`**: All steward agents write significant events to their execution's `result_data` JSONB field. For example, `{"actions": [{"type": "enqueued_deep_analysis", "repo": "owner/repo", "reason": "cadence_reentry"}]}`. The operator console queries execution history across all steward agents (`WHERE agent_id IN (SELECT id FROM agents WHERE name LIKE 'steward_%')`). No separate table needed — execution records ARE the event log.

### 11.2 Known Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Orphan repos double-enqueued (backlog + lint) | Lint checks activeRepos before enqueuing (Fix 4) |
| TOCTOU on slot reservation | Atomic slot check via `active_execution_count` counter (Fix 3) |
| Cooldowns reset on agent restart | DB-backed cooldowns (Fix 2) |
| LLM cost explosion on backfill | 10-min LLM cooldown + backlog size threshold (Fix 5) |
| Discovery flooding (cadence + scope) | Cross-agent discovery dedup query (Fix 6) |
| Double signal cards on restart | DB cooldown + signal ID dedup check (Fix 8) |
| Empty trends (signal detection hasn't run) | Freshness check: skip trend if no signals in 48h (Fix 9) |

---

## 12. Open Decisions

These are deferred to the implementation plan stage:

1. **PostgreSQL connection:** netease-pub PostgreSQL host/port/credentials setup
2. **Auth model — resolved:** One API key per project for SDK auth. Dashboard uses HTTP Basic Auth (upgrade to JWT in Phase 5).
3. **Multi-tenancy — resolved:** No "organization" concept in v1. Projects are the top-level scope. Cross-project trigger auth via `allow_trigger_from`.
4. **Dashboard tech — resolved:** Keep existing React + Vite shell, rebuild views.
5. **Deployment:** Docker compose on netease-pub? Systemd? Separate VM?
6. **Existing code cleanup — resolved:** Progressive migration (Section 9). Old+new hubs coexist during transition.

---

## 13. Alerting Rules

Evaluated by the scheduler's AlertEvaluator every 10 seconds. Severity: `critical` (immediate operator attention) / `warning` (dashboard highlight) / `info` (stats only).

### Critical

| # | Rule | Condition |
|---|------|-----------|
| 1 | **Agent offline** | `executor_status = 'online'` AND `last_heartbeat_at < now() - 60s` |
| 2 | **Failure rate spike** | `COUNT(status='failed') / COUNT(*) > 0.5` over last 1h per agent, `COUNT(*) >= 4` |
| 3 | **Queue depth anomaly** | `COUNT(status='queued') > 10` for single agent, sustained >5 min |
| 4 | **Timeout cascade** | `COUNT(status='timeout') > 3` in last 30 min for same agent |

### Warning

| # | Rule | Condition |
|---|------|-----------|
| 5 | **Retries exhausted** | `retry_count >= retry_max` on any recent execution |
| 6 | **Consecutive failures** | Last 3 executions for an agent all `failed` |
| 7 | **Registered but never executed** | `enabled=true`, `cron_expression IS NOT NULL`, `last_execution_at IS NULL` for >1h |
| 8 | **Cost anomaly** | `SUM(cost_estimate)` for single execution exceeds $5.00 |

### Info

| # | Rule | Condition |
|---|------|-----------|
| 9 | **Retention cleanup executed** | Log rows deleted |
| 10 | **Scheduler tick latency** | Tick duration >1s |

Alert dispatch uses a pluggable `AlertSink` interface. Phase 1: WebSocket broadcast + `alert_log` table. Phase 5: Slack webhook, email.

---

## 14. Scale Boundaries & Temporal Migration Criteria

This design is appropriate for the current and foreseeable scale. Move to Temporal (or similar durable execution platform) when **any** of these thresholds are crossed:

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Project count | >5 | Multi-tenancy and isolation become important |
| Agent count | >100 | Cron evaluation loop becomes CPU-bound (1000 `croner.nextRun()` calls/sec) |
| Executions/day | >5,000 | PostgreSQL write throughput starts mattering |
| Concurrent executions | >50 | Matcher query with `FOR UPDATE SKIP LOCKED` becomes bottleneck |
| Workflow complexity | >3 sequential steps per execution | Durable execution (Temporal's core strength) becomes valuable |
| Trace volume | >200,000 traces/day | PG storage becomes cost-prohibitive; ClickHouse makes sense |

**Why Temporal would be the migration target**: Temporal provides durable execution (survive process crashes mid-workflow), exactly-once execution guarantees, child workflow DAGs, SDKs in 7+ languages, and battle-tested operational maturity. The tradeoff is operational complexity: minimum 4 services (Frontend, Matching, History, DB) vs. our current 1 process + PG.

**Until these thresholds are crossed, the single-process + PostgreSQL design is the right call.** Simplicity is a feature at this scale.

---

## 15. References

| Project | URL | Relevance |
|---------|-----|-----------|
| xxl-job | https://github.com/xuxueli/xxl-job | Architecture, misfire policy, executor model |
| Temporal | https://github.com/temporalio/temporal | Task Queue, Event Sourcing, child workflow pattern |
| Prefect | https://github.com/PrefectHQ/prefect | Work Pool, state machine, decorator SDK, `wait_for` |
| LangFuse | https://github.com/langfuse/langfuse | Trace data model |
| River | https://github.com/riverqueue/river | Go PG job queue, advisory lock leader election |
| Asynq | https://github.com/hibiken/asynq | Go Redis job queue, ServeMux handler pattern |
| croner | https://github.com/Hexagon/croner | TypeScript cron parser |
| drizzle-orm | https://github.com/drizzle-team/drizzle-orm | TypeScript ORM, PG support |
| Airflow | https://github.com/apache/airflow | Grid View, TriggerDagRunOperator, pool/slot model |
| Stripe | https://stripe.com/docs/api/idempotency | Idempotency key pattern |
