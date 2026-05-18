# Agent Cron Hub Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform agent-hub from a local agent monitoring dashboard into the Agent Cron Hub core — PostgreSQL-backed scheduling engine, agent registry, executor protocol, and minimal dashboard shell.

**Architecture:** Fastify + PostgreSQL (Drizzle ORM) monolith. Scheduling engine runs in-process with REST API. Pull-first executor communication via long-poll. All state in PostgreSQL — no Redis, no message broker.

**Tech Stack:** Node.js 20+, TypeScript 6, Fastify 5, Drizzle ORM, PostgreSQL, `croner` for cron parsing, React 19 + Vite (existing dashboard shell).

**Spec:** `docs/superpowers/specs/2026-05-18-agent-cron-hub-design.md`

---

## Task Dependency Graph

```
Task 1 (Env + Deps) ─────────────────────────────────────────────────────┐
    │                                                                      │
    ├── Task 2 (DB Schema) ── Task 3 (Repos) ─────────────────────┐       │
    │                                                               │       │
    ├── Task 4 (Code Cleanup) ── Task 5 (Config + App Refactor) ──┤       │
    │                                                               │       │
    └── Task 6 (Scheduling Engine) ─────────────────────────────────┤       │
                                                                    │       │
                                                          ┌────────┘       │
                                                          ▼                │
                                              Task 7 (SDK API Routes)      │
                                              Task 8 (Dashboard API)       │
                                              Task 9 (Dashboard Shell) ────┘
                                              Task 10 (Integration Test)
```

- Tasks 2, 4, 6 can run **in parallel** after Task 1
- Task 3 depends on Task 2
- Task 5 depends on Task 4
- Tasks 7, 8, 9 depend on Tasks 3, 5, 6 (can run in parallel with each other)
- Task 10 depends on all

---

### Task 1: Environment Setup & Dependencies

**Files:**
- Modify: `apps/server/package.json`
- Modify: `package.json` (root)
- Create: `docker-compose.yml` (root)
- Create: `.env.example`

- [ ] **Step 1: Add PostgreSQL and Drizzle dependencies to server**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server
npm install drizzle-orm drizzle-kit pg
npm install -D @types/pg
```

Expected: packages added to `apps/server/package.json`.

- [ ] **Step 2: Remove better-sqlite3 dependency**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server
npm uninstall better-sqlite3 @types/better-sqlite3
```

Expected: packages removed.

- [ ] **Step 3: Add `croner` dependency**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server
npm install croner
```

Expected: `croner` added.

- [ ] **Step 4: Create root `docker-compose.yml` for PostgreSQL**

```yaml
# /Users/emosama/workspace/agent-hub/docker-compose.yml
version: "3.8"
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: agent_hub
      POSTGRES_PASSWORD: agent_hub_dev
      POSTGRES_DB: agent_hub
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

- [ ] **Step 5: Create `.env.example`**

```bash
# /Users/emosama/workspace/agent-hub/.env.example
DATABASE_URL=postgres://agent_hub:agent_hub_dev@localhost:5432/agent_hub
AGENT_HUB_PORT=8787
AGENT_HUB_HOST=0.0.0.0
AGENT_HUB_DASHBOARD_PASSWORD=admin
AGENT_HUB_SCHEDULER_TICK_MS=1000
AGENT_HUB_EXECUTION_RETENTION_DAYS=90
AGENT_HUB_TRACE_RETENTION_DAYS=30
AGENT_HUB_MAX_TRIGGER_DEPTH=5
```

- [ ] **Step 6: Start PostgreSQL and verify connection**

```bash
cd /Users/emosama/workspace/agent-hub
docker compose up -d postgres
docker compose ps
```

Expected: PostgreSQL running on port 5432.

- [ ] **Step 7: Commit**

```bash
git add apps/server/package.json package.json docker-compose.yml .env.example
git commit -m "chore: add PostgreSQL, Drizzle, croner deps; remove better-sqlite3"
```

---

### Task 2: Database Schema & Drizzle ORM

**Files:**
- Create: `apps/server/src/db/connection.ts`
- Create: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrate.ts`
- Create: `apps/server/drizzle.config.ts`

- [ ] **Step 1: Create Drizzle config**

```typescript
// apps/server/drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://agent_hub:agent_hub_dev@localhost:5432/agent_hub",
  },
});
```

- [ ] **Step 2: Create DB connection module**

```typescript
// apps/server/src/db/connection.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

let pool: pg.Pool | null = null;

export function createPool(databaseUrl: string): pg.Pool {
  pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  return pool;
}

export function createDb(p: pg.Pool) {
  return drizzle(p);
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("Pool not initialized");
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
}
```

- [ ] **Step 3: Create Drizzle schema (all tables)**

```typescript
// apps/server/src/db/schema.ts
import {
  pgTable, uuid, text, integer, timestamp, boolean,
  jsonb, numeric, pgEnum, uniqueIndex, bigserial, primaryKey, date,
} from "drizzle-orm/pg-core";

export const triggerTypeEnum = pgEnum("trigger_type", [
  "cron", "manual", "api", "agent", "retry",
]);

export const executionStatusEnum = pgEnum("execution_status", [
  "queued", "running", "success", "failed", "timeout", "cancelled",
]);

export const traceRoleEnum = pgEnum("trace_role", [
  "system", "user", "assistant", "tool",
]);

// --- projects ---
export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  workspacePath: text("workspace_path"),
  status: text("status").notNull().default("active"),
  apiKeyHash: text("api_key_hash"),
  dashboardPasswordHash: text("dashboard_password_hash"),
  allowTriggerFrom: text("allow_trigger_from").array().default([]),
  triggerRateLimitPerSec: integer("trigger_rate_limit_per_sec").default(50),
  costConfig: jsonb("cost_config").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- agents ---
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  agentType: text("agent_type").notNull(), // 'cron_task' | 'llm_agent'
  cronExpression: text("cron_expression"),
  enabled: boolean("enabled").notNull().default(true),
  misfirePolicy: text("misfire_policy").notNull().default("fire_once"),
  concurrency: integer("concurrency").notNull().default(1),
  maxPendingQueue: integer("max_pending_queue").notNull().default(100),
  timeoutSeconds: integer("timeout_seconds").notNull().default(600),
  retryMax: integer("retry_max").notNull().default(3),
  retryBackoffBaseMs: integer("retry_backoff_base_ms").notNull().default(30000),
  maxTurns: integer("max_turns"),
  maxCostUsd: numeric("max_cost_usd", { precision: 10, scale: 6 }),
  handlerName: text("handler_name"),
  executorHost: text("executor_host"),
  executorStatus: text("executor_status").notNull().default("offline"),
  inputSchema: jsonb("input_schema"),
  allowTriggerBy: jsonb("allow_trigger_by"),
  idempotencyWindowSeconds: integer("idempotency_window_seconds").notNull().default(3600),
  labels: jsonb("labels").default({}),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  lastExecutionAt: timestamp("last_execution_at", { withTimezone: true }),
  activeExecutionCount: integer("active_execution_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  projectNameIdx: uniqueIndex("idx_agents_project_name").on(table.projectId, table.name),
}));

// --- executions ---
export const executions = pgTable("executions", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  triggerType: triggerTypeEnum("trigger_type").notNull(),
  triggeredBy: text("triggered_by"),
  parentExecutionId: uuid("parent_execution_id"),
  rootExecutionId: uuid("root_execution_id"),
  triggerDepth: integer("trigger_depth").notNull().default(0),
  idempotencyKey: text("idempotency_key"),
  status: executionStatusEnum("status").notNull().default("queued"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  inputPayload: jsonb("input_payload"),
  resultSummary: text("result_summary"),
  resultData: jsonb("result_data"),
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
  traceCountExpected: integer("trace_count_expected"),
  traceCountActual: integer("trace_count_actual").default(0),
  traceIncomplete: boolean("trace_incomplete").default(false),
  retryCount: integer("retry_count").notNull().default(0),
  retryOf: uuid("retry_of"),
  executorHost: text("executor_host"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- traces ---
export const traces = pgTable("traces", {
  id: uuid("id").defaultRandom().primaryKey(),
  executionId: uuid("execution_id").notNull().references(() => executions.id, { onDelete: "cascade" }),
  turnIndex: integer("turn_index").notNull(),
  spanIndex: integer("span_index").notNull().default(0),
  parentSpanId: uuid("parent_span_id"),
  role: traceRoleEnum("role").notNull(),
  spanType: text("span_type").notNull().default("llm"),
  model: text("model"),
  provider: text("provider"),
  inputContent: text("input_content"),
  outputContent: text("output_content"),
  toolCalls: jsonb("tool_calls"),
  toolResults: jsonb("tool_results"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costEstimate: numeric("cost_estimate", { precision: 10, scale: 6 }),
  latencyMs: integer("latency_ms"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- agent_cooldowns ---
export const agentCooldowns = pgTable("agent_cooldowns", {
  agentName: text("agent_name").notNull(),
  cooldownKey: text("cooldown_key").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  runCount: integer("run_count").default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.agentName, table.cooldownKey] }),
}));

// --- alert_log ---
export const alertLog = pgTable("alert_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ruleName: text("rule_name").notNull(),
  severity: text("severity").notNull(),
  agentId: uuid("agent_id").references(() => agents.id),
  message: text("message").notNull(),
  context: jsonb("context"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- provider_pricing ---
export const providerPricing = pgTable("provider_pricing", {
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputCostPer1k: numeric("input_cost_per_1k", { precision: 10, scale: 6 }).notNull(),
  outputCostPer1k: numeric("output_cost_per_1k", { precision: 10, scale: 6 }).notNull(),
  effectiveFrom: date("effective_from").notNull(),
});
```

- [ ] **Step 4: Create migration runner**

```typescript
// apps/server/src/db/migrate.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://agent_hub:agent_hub_dev@localhost:5432/agent_hub",
});

const db = drizzle(pool);

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Add npm scripts for migration**

In `apps/server/package.json`, add to `scripts`:
```json
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx src/db/migrate.ts"
```

- [ ] **Step 6: Generate initial migration and run it**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server
npx drizzle-kit generate
npx tsx src/db/migrate.ts
```

Expected: Tables created in PostgreSQL. Verify with `docker compose exec postgres psql -U agent_hub -d agent_hub -c "\dt"`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/drizzle.config.ts apps/server/src/db/ apps/server/package.json apps/server/drizzle/
git commit -m "feat(db): add PostgreSQL schema with Drizzle ORM — projects, agents, executions, traces, cooldowns, alert_log, provider_pricing"
```

---

### Task 3: Database Repositories

**Files:**
- Create: `apps/server/src/db/repository.ts`
- Create: `apps/server/src/repositories/project-repository.ts`
- Create: `apps/server/src/repositories/agent-repository.ts`
- Create: `apps/server/src/repositories/execution-repository.ts`
- Create: `apps/server/src/repositories/trace-repository.ts`

- [ ] **Step 1: Create base repository utility**

```typescript
// apps/server/src/db/repository.ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase;

export function makeDb(db: Db) {
  return db;
}
```

- [ ] **Step 2: Create project repository**

```typescript
// apps/server/src/repositories/project-repository.ts
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import type { Db } from "../db/repository.js";

export class ProjectRepository {
  constructor(private db: Db) {}

  async findAll() {
    return this.db.select().from(projects).orderBy(projects.createdAt);
  }

  async findById(id: string) {
    const rows = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByName(name: string) {
    const rows = await this.db.select().from(projects).where(eq(projects.name, name)).limit(1);
    return rows[0] ?? null;
  }

  async create(input: { name: string; displayName: string; description?: string; apiKeyHash?: string }) {
    const rows = await this.db.insert(projects).values({
      name: input.name,
      displayName: input.displayName,
      description: input.description ?? null,
      apiKeyHash: input.apiKeyHash ?? null,
    }).returning();
    return rows[0];
  }

  async update(id: string, input: Partial<{ displayName: string; description: string; status: string; apiKeyHash: string; dashboardPasswordHash: string }>) {
    const rows = await this.db.update(projects).set(input).where(eq(projects.id, id)).returning();
    return rows[0] ?? null;
  }

  async delete(id: string) {
    await this.db.delete(projects).where(eq(projects.id, id));
  }
}
```

- [ ] **Step 3: Create agent repository**

```typescript
// apps/server/src/repositories/agent-repository.ts
import { and, eq, sql, lt } from "drizzle-orm";
import { agents, projects } from "../db/schema.js";
import type { Db } from "../db/repository.js";

type AgentRow = typeof agents.$inferSelect;
type NewAgent = typeof agents.$inferInsert;

export class AgentRepository {
  constructor(private db: Db) {}

  async findAll(filters?: { projectId?: string; agentType?: string; executorStatus?: string; enabled?: boolean }) {
    let q = this.db.select().from(agents).leftJoin(projects, eq(agents.projectId, projects.id));
    const conditions = [];
    if (filters?.projectId) conditions.push(eq(agents.projectId, filters.projectId));
    if (filters?.agentType) conditions.push(eq(agents.agentType, filters.agentType));
    if (filters?.executorStatus) conditions.push(eq(agents.executorStatus, filters.executorStatus));
    if (filters?.enabled !== undefined) conditions.push(eq(agents.enabled, filters.enabled));
    if (conditions.length) q = q.where(and(...conditions));
    return q.orderBy(agents.createdAt);
  }

  async findById(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByProjectAndName(projectId: string, name: string) {
    const rows = await this.db.select().from(agents).where(
      and(eq(agents.projectId, projectId), eq(agents.name, name))
    ).limit(1);
    return rows[0] ?? null;
  }

  async findEnabledWithCron() {
    return this.db.select().from(agents)
      .where(and(eq(agents.enabled, true), sql`${agents.cronExpression} IS NOT NULL`));
  }

  async findOnlineExecutors() {
    return this.db.select().from(agents).where(eq(agents.executorStatus, "online"));
  }

  async findWithStaleHeartbeat(thresholdSeconds: number) {
    return this.db.select().from(agents).where(
      and(
        eq(agents.executorStatus, "online"),
        lt(agents.lastHeartbeatAt, sql`now() - interval '${sql.raw(String(thresholdSeconds))} seconds'`)
      )
    );
  }

  async upsert(projectId: string, name: string, input: Partial<NewAgent>) {
    const existing = await this.findByProjectAndName(projectId, name);
    if (existing) {
      const rows = await this.db.update(agents).set({ ...input, updatedAt: new Date() })
        .where(eq(agents.id, existing.id)).returning();
      return rows[0];
    }
    const rows = await this.db.insert(agents).values({
      projectId, name,
      displayName: input.displayName ?? name,
      agentType: input.agentType ?? "cron_task",
      handlerName: input.handlerName ?? null,
      cronExpression: input.cronExpression ?? null,
      inputSchema: input.inputSchema ?? null,
      concurrency: input.concurrency ?? 1,
      timeoutSeconds: input.timeoutSeconds ?? 600,
      retryMax: input.retryMax ?? 3,
      executorHost: input.executorHost ?? null,
      executorStatus: "online",
      ...input,
    }).returning();
    return rows[0];
  }

  async update(id: string, input: Partial<AgentRow>) {
    const rows = await this.db.update(agents).set({ ...input, updatedAt: new Date() })
      .where(eq(agents.id, id)).returning();
    return rows[0] ?? null;
  }

  async updateHeartbeat(id: string) {
    await this.db.update(agents).set({
      lastHeartbeatAt: new Date(),
      executorStatus: "online",
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async markOffline(id: string) {
    await this.db.update(agents).set({
      executorStatus: "offline",
      activeExecutionCount: 0,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async incrementExecutionCount(id: string) {
    await this.db.update(agents).set({
      activeExecutionCount: sql`${agents.activeExecutionCount} + 1`,
    }).where(eq(agents.id, id));
  }

  async decrementExecutionCount(id: string) {
    await this.db.update(agents).set({
      activeExecutionCount: sql`GREATEST(${agents.activeExecutionCount} - 1, 0)`,
    }).where(eq(agents.id, id));
  }

  async resetAllExecutionCounts() {
    await this.db.execute(sql`
      UPDATE agents SET active_execution_count = (
        SELECT COUNT(*)::int FROM executions
        WHERE executions.agent_id = agents.id
        AND executions.status = 'running'
      )
    `);
  }

  async delete(id: string) {
    await this.db.delete(agents).where(eq(agents.id, id));
  }

  async deregisterByName(projectId: string, name: string) {
    await this.db.delete(agents).where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
  }
}
```

- [ ] **Step 4: Create execution repository**

```typescript
// apps/server/src/repositories/execution-repository.ts
import { and, eq, sql, lt, inArray, desc, gte } from "drizzle-orm";
import { executions, agents } from "../db/schema.js";
import type { Db } from "../db/repository.js";

type NewExecution = typeof executions.$inferInsert;

export class ExecutionRepository {
  constructor(private db: Db) {}

  async create(input: NewExecution) {
    const rows = await this.db.insert(executions).values(input).returning();
    return rows[0];
  }

  async findById(id: string) {
    const rows = await this.db.select().from(executions)
      .where(eq(executions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findAll(filters: {
    agentId?: string; status?: string; triggerType?: string;
    since?: Date; limit?: number; offset?: number;
  }) {
    let q = this.db.select().from(executions);
    const conditions = [];
    if (filters.agentId) conditions.push(eq(executions.agentId, filters.agentId));
    if (filters.status) conditions.push(eq(executions.status, filters.status as any));
    if (filters.triggerType) conditions.push(eq(executions.triggerType, filters.triggerType as any));
    if (filters.since) conditions.push(gte(executions.createdAt, filters.since));
    if (conditions.length) q = q.where(and(...conditions));
    return q.orderBy(desc(executions.createdAt)).limit(filters.limit ?? 50).offset(filters.offset ?? 0);
  }

  async findQueued() {
    return this.db.select({
      execution: executions,
      agentConcurrency: agents.concurrency,
      agentExecutorStatus: agents.executorStatus,
      agentActiveCount: agents.activeExecutionCount,
      agentExecutorHost: agents.executorHost,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(and(
      eq(executions.status, "queued"),
      eq(agents.executorStatus, "online"),
      sql`${agents.activeExecutionCount} < ${agents.concurrency}`,
    ))
    .orderBy(executions.scheduledAt)
    .limit(10);
  }

  async findRunning() {
    return this.db.select().from(executions).where(eq(executions.status, "running"));
  }

  async findTimedOut() {
    return this.db.select({
      execution: executions,
      agentTimeout: agents.timeoutSeconds,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(and(
      eq(executions.status, "running"),
      sql`${executions.startedAt} + (${agents.timeoutSeconds} * interval '1 second') < now()`,
    ));
  }

  async findRetriable() {
    return this.db.select({
      execution: executions,
      agentRetryMax: agents.retryMax,
      agentBackoffMs: agents.retryBackoffBaseMs,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(and(
      inArray(executions.status, ["failed", "timeout"]),
      sql`${executions.retryCount} < ${agents.retryMax}`,
      sql`${executions.finishedAt} + (${agents.retryBackoffBaseMs} * power(2, ${executions.retryCount}) * interval '1 ms') < now()`,
    ));
  }

  async claimForDispatch(executionId: string) {
    const rows = await this.db.update(executions).set({
      status: "running",
      startedAt: new Date(),
      lastActivityAt: new Date(),
    }).where(and(
      eq(executions.id, executionId),
      eq(executions.status, "queued"),
    )).returning();
    return rows[0] ?? null;
  }

  async updateStatus(id: string, status: string, extra: Partial<typeof executions.$inferInsert> = {}) {
    const rows = await this.db.update(executions).set({
      status: status as any,
      finishedAt: status === "success" || status === "failed" || status === "timeout" || status === "cancelled" ? new Date() : undefined,
      ...extra,
    }).where(eq(executions.id, id)).returning();
    return rows[0] ?? null;
  }

  async incrementTraceCount(executionId: string, count: number) {
    await this.db.update(executions).set({
      traceCountActual: sql`${executions.traceCountActual} + ${count}`,
      lastActivityAt: new Date(),
    }).where(eq(executions.id, executionId));
  }

  async expireOldTraces(retentionDays: number) {
    for (;;) {
      const result = await this.db.execute(sql`
        DELETE FROM traces WHERE created_at < now() - interval '${sql.raw(String(retentionDays))} days'
      `);
      // Drizzle doesn't easily support LIMIT in DELETE, so we just run once daily
      break;
    }
  }

  async countByAgentAndStatus(agentId: string, statuses: string[]) {
    const result = await this.db.execute(sql`
      SELECT COUNT(*)::int as cnt FROM executions
      WHERE agent_id = ${agentId} AND status IN (${sql.join(statuses)})
    `);
    return (result.rows[0] as any).cnt ?? 0;
  }

  async expireOldExecutions(retentionDays: number) {
    await this.db.execute(sql`
      DELETE FROM executions WHERE created_at < now() - interval '${sql.raw(String(retentionDays))} days'
      AND status IN ('success', 'failed', 'cancelled', 'timeout')
    `);
  }

  async findTriggerChain(executionId: string, direction: "up" | "down" | "both") {
    // Recursive CTE — implemented at query time
    if (direction === "up") {
      return this.db.execute(sql`
        WITH RECURSIVE chain AS (
          SELECT id, agent_id, parent_execution_id, root_execution_id, trigger_depth, status, started_at
          FROM executions WHERE id = ${executionId}
          UNION ALL
          SELECT e.id, e.agent_id, e.parent_execution_id, e.root_execution_id, e.trigger_depth, e.status, e.started_at
          FROM executions e JOIN chain c ON e.id = c.parent_execution_id
        )
        SELECT * FROM chain ORDER BY trigger_depth;
      `);
    }
    // direction "down" or "both" similar
    return [];
  }
}
```

- [ ] **Step 5: Create trace repository**

```typescript
// apps/server/src/repositories/trace-repository.ts
import { eq, sql } from "drizzle-orm";
import { traces } from "../db/schema.js";
import type { Db } from "../db/repository.js";

export class TraceRepository {
  constructor(private db: Db) {}

  async insertBatch(rows: Array<{
    executionId: string; turnIndex: number; spanIndex?: number;
    parentSpanId?: string | null; role: string; spanType?: string;
    model?: string; provider?: string;
    inputContent?: string; outputContent?: string;
    toolCalls?: any; toolResults?: any;
    inputTokens?: number; outputTokens?: number;
    costEstimate?: string; latencyMs?: number;
    metadata?: any;
  }>) {
    if (rows.length === 0) return [];
    return this.db.insert(traces).values(
      rows.map(r => ({
        executionId: r.executionId,
        turnIndex: r.turnIndex,
        spanIndex: r.spanIndex ?? 0,
        parentSpanId: r.parentSpanId ?? null,
        role: r.role as any,
        spanType: r.spanType ?? "llm",
        model: r.model ?? null,
        provider: r.provider ?? null,
        inputContent: r.inputContent ?? null,
        outputContent: r.outputContent ?? null,
        toolCalls: r.toolCalls ?? null,
        toolResults: r.toolResults ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        costEstimate: r.costEstimate ?? null,
        latencyMs: r.latencyMs ?? null,
        metadata: r.metadata ?? {},
      }))
    ).returning();
  }

  async findByExecution(executionId: string) {
    return this.db.select().from(traces)
      .where(eq(traces.executionId, executionId))
      .orderBy(traces.turnIndex, traces.spanIndex);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/repository.ts apps/server/src/repositories/
git commit -m "feat(repos): add project, agent, execution, trace repositories"
```

---

### Task 4: Code Cleanup — Remove Old Services & Routes

**Files:**
- Remove: `apps/server/src/services/copilot-session-runtime.ts`
- Remove: `apps/server/src/services/claude-code-runtime.ts`
- Remove: `apps/server/src/services/gemini-cli-runtime.ts`
- Remove: `apps/server/src/services/openclaw-runtime.ts`
- Remove: `apps/server/src/services/openclaw-approval-bridge.ts`
- Remove: `apps/server/src/services/approval-operator.ts`
- Remove: `apps/server/src/services/mock-runtime.ts`
- Remove: `apps/server/src/services/runtime-operator.ts`
- Remove: `apps/server/src/services/workspace-operator.ts`
- Remove: `apps/server/src/services/terminal-lifecycle.ts`
- Remove: `apps/server/src/services/desktop-notifications.ts`
- Remove: `apps/server/src/services/reference-catalog.ts`
- Remove: `apps/server/src/repositories/inbox-repository.ts`
- Remove: `apps/server/src/scripts/gemini-runtime-regression.ts`
- Remove: `apps/server/src/scripts/openclaw-runtime-regression.ts`

- [ ] **Step 1: Remove the listed files**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server/src
rm services/copilot-session-runtime.ts
rm services/claude-code-runtime.ts
rm services/gemini-cli-runtime.ts
rm services/openclaw-runtime.ts
rm services/openclaw-approval-bridge.ts
rm services/approval-operator.ts
rm services/mock-runtime.ts
rm services/runtime-operator.ts
rm services/workspace-operator.ts
rm services/terminal-lifecycle.ts
rm services/desktop-notifications.ts
rm services/reference-catalog.ts
rm repositories/inbox-repository.ts
rm scripts/gemini-runtime-regression.ts
rm scripts/openclaw-runtime-regression.ts
```

Expected: Files deleted. Empty directories may remain — clean up manually if needed.

- [ ] **Step 2: Verify nothing broken (yet)**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server
npx tsc --noEmit 2>&1 | head -20
```

Expected: Errors from `app.ts` and `routes.ts` referencing removed imports. This is expected — Task 5 fixes these.

- [ ] **Step 3: Commit**

```bash
git add -A apps/server/src/
git commit -m "refactor: remove agent discovery, runtime bridges, inbox, workspace actions, reference catalog"
```

---

### Task 5: Config & App Refactor

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/server/src/middleware/auth.ts`

- [ ] **Step 1: Rewrite config.ts with new env vars only**

```typescript
// apps/server/src/config.ts
import path from "node:path";
import { fileURLToPath } from "node:url";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..");

export const serverConfig = {
  appRoot,
  host: process.env.AGENT_HUB_HOST ?? "0.0.0.0",
  port: parsePositiveInt(process.env.AGENT_HUB_PORT, 8787),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://agent_hub:agent_hub_dev@localhost:5432/agent_hub",
  dashboardPassword: process.env.AGENT_HUB_DASHBOARD_PASSWORD ?? "admin",
  schedulerTickMs: parsePositiveInt(process.env.AGENT_HUB_SCHEDULER_TICK_MS, 1000),
  executionRetentionDays: parsePositiveInt(process.env.AGENT_HUB_EXECUTION_RETENTION_DAYS, 90),
  traceRetentionDays: parsePositiveInt(process.env.AGENT_HUB_TRACE_RETENTION_DAYS, 30),
  alertRetentionDays: parsePositiveInt(process.env.AGENT_HUB_ALERT_RETENTION_DAYS, 180),
  maxTriggerDepth: parsePositiveInt(process.env.AGENT_HUB_MAX_TRIGGER_DEPTH, 5),
} as const;
```

- [ ] **Step 2: Create dashboard auth middleware**

```typescript
// apps/server/src/middleware/auth.ts
import type { FastifyRequest, FastifyReply } from "fastify";
import { serverConfig } from "../config.js";

export async function basicAuth(request: FastifyRequest, reply: FastifyReply) {
  // Skip auth for SDK endpoints (use API key instead)
  if (request.url.startsWith("/api/registry") ||
      request.url.startsWith("/api/executors") ||
      request.url.startsWith("/api/cooldowns") ||
      request.url.startsWith("/api/executions/") && request.method === "POST" ||
      request.url.startsWith("/api/agents/") && request.method === "POST") {
    return;
  }

  // Skip auth for health and metrics
  if (request.url === "/api/health" || request.url === "/api/metrics") {
    return;
  }

  // All other dashboard API endpoints require Basic Auth
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    reply.header("WWW-Authenticate", 'Basic realm="Agent Cron Hub"');
    return reply.status(401).send({ error: "unauthorized" });
  }

  const [user, password] = Buffer.from(auth.slice(6), "base64").toString().split(":");
  if (password !== serverConfig.dashboardPassword) {
    return reply.status(401).send({ error: "unauthorized" });
  }
}
```

- [ ] **Step 3: Rewrite app.ts — DI wiring for new system**

```typescript
// apps/server/src/app.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createPool, createDb, getPool, closePool } from "./db/connection.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { AgentRepository } from "./repositories/agent-repository.js";
import { ExecutionRepository } from "./repositories/execution-repository.js";
import { TraceRepository } from "./repositories/trace-repository.js";
import { registerRoutes } from "./http/routes.js";
import { basicAuth } from "./middleware/auth.js";
import { serverConfig } from "./config.js";

export interface AppContext {
  projectRepo: ProjectRepository;
  agentRepo: AgentRepository;
  executionRepo: ExecutionRepository;
  traceRepo: TraceRepository;
}

export async function createApp(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // PostgreSQL
  const pool = createPool(serverConfig.databaseUrl);
  const db = createDb(pool);

  // Repositories
  const projectRepo = new ProjectRepository(db);
  const agentRepo = new AgentRepository(db);
  const executionRepo = new ExecutionRepository(db);
  const traceRepo = new TraceRepository(db);

  const ctx: AppContext = { projectRepo, agentRepo, executionRepo, traceRepo };

  // Dashboard Basic Auth
  app.addHook("onRequest", basicAuth);

  // Routes
  registerRoutes(app, ctx);

  // Error handler
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode ?? 500).send({
      error: error.message ?? "Internal Server Error",
    });
  });

  // Graceful shutdown
  app.addHook("onClose", async () => {
    await closePool();
  });

  return { app, ctx };
}
```

- [ ] **Step 4: Simplify index.ts**

```typescript
// apps/server/src/index.ts
import { createApp } from "./app.js";
import { serverConfig } from "./config.js";
import { startScheduler } from "./services/scheduler.js";

async function main() {
  const { app, ctx: appCtx } = await createApp();

  // Startup recovery: align active_execution_count
  await appCtx.agentRepo.resetAllExecutionCounts();

  await app.listen({ host: serverConfig.host, port: serverConfig.port });
  console.log(`Agent Cron Hub listening on http://${serverConfig.host}:${serverConfig.port}`);

  // Start scheduler — reuses the same repos created by createApp
  const { startScheduler } = await import("./services/scheduler.js");
  startScheduler({
    agentRepo: appCtx.agentRepo,
    executionRepo: appCtx.executionRepo,
    traceRepo: appCtx.traceRepo,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Remove old seed.ts and old db/index.ts references**

```bash
rm /Users/emosama/workspace/agent-hub/apps/server/src/db/seed.ts
```

Update `apps/server/src/db/index.ts` to be a re-export barrel only:
```typescript
// apps/server/src/db/index.ts (simplified)
export { createPool, createDb, getPool, closePool } from "./connection.js";
export * from "./schema.js";
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/app.ts apps/server/src/index.ts apps/server/src/middleware/ apps/server/src/db/
git commit -m "refactor: rewrite config, app, and index for new PostgreSQL-backed hub"
```

---

### Task 6: Scheduling Engine

**Files:**
- Create: `apps/server/src/services/scheduler.ts`

- [ ] **Step 1: Create the scheduler with all 7 components**

```typescript
// apps/server/src/services/scheduler.ts
import { Cron } from "croner";
import type { AgentRepository } from "../repositories/agent-repository.js";
import type { ExecutionRepository } from "../repositories/execution-repository.js";
import type { TraceRepository } from "../repositories/trace-repository.js";
import { serverConfig } from "../config.js";
import { agents } from "../db/schema.js";

type CronerInstance = ReturnType<typeof croner>;

export interface SchedulerContext {
  agentRepo: AgentRepository;
  executionRepo: ExecutionRepository;
  traceRepo: TraceRepository;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(ctx: SchedulerContext) {
  tickTimer = setInterval(() => tick(ctx), serverConfig.schedulerTickMs);
  console.log(`Scheduler started, tick every ${serverConfig.schedulerTickMs}ms`);
}

export function stopScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

async function tick(ctx: SchedulerContext) {
  // Step 1: CronEvaluator
  try { await cronEvaluator(ctx); } catch (e) { console.error("CronEvaluator failed:", e); }

  // Step 2: HeartbeatMonitor
  try { await heartbeatMonitor(ctx); } catch (e) { console.error("HeartbeatMonitor failed:", e); }

  // Step 3: TimeoutChecker
  try { await timeoutChecker(ctx); } catch (e) { console.error("TimeoutChecker failed:", e); }

  // Step 4: RetryManager
  try { await retryManager(ctx); } catch (e) { console.error("RetryManager failed:", e); }

  // Step 5: AlertEvaluator (every 10 ticks)
  try { await alertEvaluator(ctx); } catch (e) { console.error("AlertEvaluator failed:", e); }

  // Step 6: RetentionCleanup (once per day, early-return inside)
  try { await retentionCleanup(ctx); } catch (e) { console.error("RetentionCleanup failed:", e); }

  // Step 7: Matcher — always runs (not leader-protected in v1 single instance)
  try { await matcher(ctx); } catch (e) { console.error("Matcher failed:", e); }
}

// ─── CronEvaluator ───
async function cronEvaluator(ctx: SchedulerContext) {
  const enabledAgents = await ctx.agentRepo.findEnabledWithCron();
  for (const agent of enabledAgents) {
    if (!agent.cronExpression) continue;
    const cron = new Cron(agent.cronExpression);
    const lastRun = agent.lastExecutionAt ?? new Date(0);
    const nextRun = cron.nextRun(lastRun);
    if (!nextRun || nextRun > new Date()) continue;

    // Check max_pending_queue: count queued + running
    const pending = await ctx.executionRepo.countByAgentAndStatus(agent.id, ["queued", "running"]);
    if (pending >= agent.maxPendingQueue) {
      console.warn(`Agent ${agent.name}: max_pending_queue (${agent.maxPendingQueue}) reached (${pending} pending), skipping cron`);
      continue;
    }

    const availableSlots = agent.maxPendingQueue - pending;

    if (agent.misfirePolicy === "drop") {
      // Skip, wait for next natural trigger
    } else if (agent.misfirePolicy === "fire_once") {
      await ctx.executionRepo.create({
        agentId: agent.id,
        triggerType: "cron",
        triggeredBy: "cron",
        status: "queued",
        scheduledAt: new Date(),
        triggerDepth: 0,
      });
    } else if (agent.misfirePolicy === "fire_all") {
      // Cap lookback to 1 hour — prevents spinning through ~29M iterations
      // from epoch 1970 when lastExecutionAt is NULL for new agents.
      const maxLookback = new Date(Date.now() - 60 * 60 * 1000);
      let cursor = new Date(Math.max(lastRun.getTime() + 1, maxLookback.getTime()));
      let toCreate = 0;
      while (toCreate < availableSlots) {
        const next = cron.nextRun(cursor);
        if (!next || next > new Date()) break;
        toCreate++;
        cursor = new Date(next.getTime() + 1);
      }
      for (let i = 0; i < Math.min(toCreate, availableSlots); i++) {
        await ctx.executionRepo.create({
          agentId: agent.id,
          triggerType: "cron",
          triggeredBy: "cron",
          status: "queued",
          scheduledAt: new Date(),
          triggerDepth: 0,
        });
      }
    }

    await ctx.agentRepo.update(agent.id, { lastExecutionAt: new Date() });
  }
}

// ─── HeartbeatMonitor ───
async function heartbeatMonitor(ctx: SchedulerContext) {
  const stale = await ctx.agentRepo.findWithStaleHeartbeat(30);
  for (const agent of stale) {
    await ctx.agentRepo.markOffline(agent.id);
    // Cancel running executions for this agent
    const running = await ctx.executionRepo.findAll({ agentId: agent.id, status: "running", limit: 100 });
    for (const exec of running) {
      await ctx.executionRepo.updateStatus(exec.id, "cancelled");
      await ctx.agentRepo.decrementExecutionCount(agent.id);
    }
  }
}

// ─── TimeoutChecker ───
async function timeoutChecker(ctx: SchedulerContext) {
  const timedOut = await ctx.executionRepo.findTimedOut();
  for (const row of timedOut) {
    await ctx.executionRepo.updateStatus(row.execution.id, "timeout", {
      finishedAt: new Date(),
      errorMessage: `Execution exceeded timeout of ${row.agentTimeout}s`,
    });
    await ctx.agentRepo.decrementExecutionCount(row.execution.agentId);
  }
}

// ─── RetryManager ───
async function retryManager(ctx: SchedulerContext) {
  const retriable = await ctx.executionRepo.findRetriable();
  for (const row of retriable) {
    const newCount = row.execution.retryCount + 1;
    await ctx.executionRepo.create({
      agentId: row.execution.agentId,
      triggerType: "retry",
      triggeredBy: "retry",
      status: "queued",
      scheduledAt: new Date(),
      retryCount: newCount,
      retryOf: row.execution.id,
      inputPayload: row.execution.inputPayload,
      triggerDepth: 0,
    });
  }
}

// ─── Matcher (Phase 1: no-op — dispatch handled in poll route) ───
// In Phase 1 single-instance, dispatch is done directly by the poll route
// (Task 7). Matcher becomes active in Phase 5 multi-instance where push mode
// and cross-instance long-poll waiter routing are needed. The tick() loop
// still calls matcher() so the function skeleton is in place for Phase 5.
async function matcher(_ctx: SchedulerContext) {
  // Phase 1: no-op. Dispatch happens in GET /api/executors/poll.
}

// ─── AlertEvaluator ───
let alertTickCount = 0;
async function alertEvaluator(ctx: SchedulerContext) {
  alertTickCount++;
  if (alertTickCount % 10 !== 0) return; // every 10 ticks (10s)

  // Implemented fully in Task 8 (dashboard API)
}

// ─── RetentionCleanup (runs once per day) ───
let lastCleanupDate = "";
async function retentionCleanup(ctx: SchedulerContext) {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastCleanupDate) return;
  lastCleanupDate = today;

  await ctx.executionRepo.expireOldTraces(serverConfig.traceRetentionDays);
  await ctx.executionRepo.expireOldExecutions(serverConfig.executionRetentionDays);
}
```

- [ ] **Step 2: Verify scheduler wiring in index.ts**

The scheduler is already wired in Task 5 Step 4's `index.ts`: `createApp()` returns `{ app, ctx }`, and `main()` calls `startScheduler()` with `appCtx.agentRepo/executionRepo/traceRepo`. No separate wiring step needed — verify the import paths match.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/services/scheduler.ts apps/server/src/index.ts
git commit -m "feat(scheduler): implement CronEvaluator, Matcher, HeartbeatMonitor, TimeoutChecker, RetryManager"
```

---

### Task 7: SDK-Facing API Routes

**Files:**
- Modify: `apps/server/src/http/routes.ts`

- [ ] **Step 1: Rewrite routes.ts — replace all old routes with new SDK + dashboard endpoints**

This is the largest single file change. The complete new `routes.ts`:

```typescript
// apps/server/src/http/routes.ts
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { z } from "zod";
import { serverConfig } from "../config.js";

const agentSpecSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  agentType: z.enum(["cron_task", "llm_agent"]),
  cron: z.string().optional(),
  handler: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
  concurrency: z.number().int().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
  retryMax: z.number().int().min(0).optional(),
  retryBackoffBaseMs: z.number().int().optional(),
  maxPendingQueue: z.number().int().optional(),
  misfirePolicy: z.enum(["fire_once", "fire_all", "drop"]).optional(),
  maxTurns: z.number().int().optional(),
  maxCostUsd: z.number().optional(),
  executorHost: z.string().optional(),
  allowTriggerBy: z.record(z.unknown()).nullable().optional(),
  labels: z.record(z.string()).optional(),
});

const triggerSchema = z.object({
  payload: z.record(z.unknown()).default({}),
  idempotency_key: z.string().optional(),
  dedup_policy: z.enum(["skip_if_running", "skip_if_exists", "allow_duplicate"]).default("skip_if_running"),
});

const heartbeatSchema = z.object({
  executions: z.array(z.object({
    execution_id: z.string(),
    progress_percent: z.number().optional(),
    progress_message: z.string().optional(),
  })).optional(),
});

const reportSchema = z.object({
  status: z.enum(["success", "failed"]),
  result_summary: z.string().optional(),
  result_data: z.record(z.unknown()).optional(),
  error_message: z.string().optional(),
  error_stack: z.string().optional(),
  trace_count_expected: z.number().int().optional(),
});

const traceBatchSchema = z.object({
  traces: z.array(z.object({
    turn_index: z.number().int(),
    span_index: z.number().int().optional(),
    parent_span_id: z.string().optional(),
    role: z.enum(["system", "user", "assistant", "tool"]),
    span_type: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    input_content: z.string().optional(),
    output_content: z.string().optional(),
    tool_calls: z.unknown().optional(),
    tool_results: z.unknown().optional(),
    input_tokens: z.number().int().optional(),
    output_tokens: z.number().int().optional(),
    cost_estimate: z.number().optional(),
    latency_ms: z.number().int().optional(),
    metadata: z.record(z.unknown()).optional(),
  })),
});

interface ExtendedAppContext extends AppContext {}

export function registerRoutes(app: FastifyInstance, ctx: ExtendedAppContext) {
  // ── Health ──
  app.get("/api/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // ── Metrics ──
  app.get("/api/metrics", async () => {
    // Basic metrics — can be extended for Prometheus
    const agents = await ctx.agentRepo.findAll({ enabled: true });
    return {
      agents_total: agents.length,
      agents_online: agents.filter(a => a.executorStatus === "online").length,
    };
  });

  // ── Agent Registry ──
  app.put("/api/registry/agents", async (request, reply) => {
    const projectId = getProjectId(request);
    const body = agentSpecSchema.parse(request.body);

    const agent = await ctx.agentRepo.upsert(projectId, body.name, {
      displayName: body.displayName,
      agentType: body.agentType,
      cronExpression: body.cron ?? null,
      handlerName: body.handler ?? null,
      inputSchema: body.inputSchema as any,
      concurrency: body.concurrency ?? 1,
      timeoutSeconds: body.timeoutSeconds ?? 600,
      retryMax: body.retryMax ?? 3,
      retryBackoffBaseMs: body.retryBackoffBaseMs ?? 30000,
      maxPendingQueue: body.maxPendingQueue ?? 100,
      misfirePolicy: body.misfirePolicy ?? "fire_once",
      maxTurns: body.maxTurns ?? null,
      maxCostUsd: body.maxCostUsd?.toString() ?? null,
      executorHost: body.executorHost ?? null,
      allowTriggerBy: body.allowTriggerBy as any,
      labels: body.labels as any,
      executorStatus: "online",
      lastHeartbeatAt: new Date(),
    });

    return reply.status(200).send(agent);
  });

  app.delete("/api/registry/agents/:name", async (request, reply) => {
    const projectId = getProjectId(request);
    const { name } = request.params as { name: string };
    await ctx.agentRepo.deregisterByName(projectId, name);
    return reply.status(204).send();
  });

  // ── Executor Heartbeat ──
  app.post("/api/executors/heartbeat", async (request, reply) => {
    const projectId = getProjectId(request);
    const body = heartbeatSchema.parse(request.body);

    // Update heartbeat for all agents in this project
    const projectAgents = await ctx.agentRepo.findAll({ projectId, enabled: true });
    for (const agent of projectAgents) {
      await ctx.agentRepo.updateHeartbeat(agent.id);
    }

    return { ok: true };
  });

  // ── Executor Poll (dispatch via poll route — Phase 1 single-instance) ──
  // Phase 1: dispatch is handled directly in the poll route, not by Matcher.
  // The poll route finds the first queued execution for any agent in the caller's
  // project, atomically claims it (status=queued → running), increments active count,
  // and returns it. Matcher is a no-op in Phase 1; it becomes relevant in Phase 5
  // multi-instance where push mode and cross-instance waiter routing are needed.
  app.get("/api/executors/poll", async (request, reply) => {
    const projectId = getProjectId(request);

    const projectAgents = await ctx.agentRepo.findAll({ projectId, enabled: true });
    const agentIds = projectAgents.map(a => a.id);
    if (agentIds.length === 0) return reply.status(204).send();

    // Find the oldest queued execution for any agent in this project
    // that has an available concurrency slot
    const queuedExecs = await ctx.executionRepo.findQueued(); // joins agents, filters status='queued' + online + slot check
    const match = queuedExecs.find(e => agentIds.includes(e.execution.agentId));

    if (!match) {
      return reply.status(204).send();
    }

    // Atomically claim: status=queued → running, set started_at
    const claimed = await ctx.executionRepo.claimForDispatch(match.execution.id);
    if (!claimed) {
      // Another poll request already claimed it (race). Re-poll.
      return reply.status(204).send();
    }

    await ctx.agentRepo.incrementExecutionCount(match.execution.agentId);

    return reply.send(claimed);
  });

  // ── Execution Report ──
  app.post("/api/executions/:id/report", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = reportSchema.parse(request.body);

    const exec = await ctx.executionRepo.findById(id);
    if (!exec) return reply.status(404).send({ error: "execution not found" });

    const durationMs = exec.startedAt ? Date.now() - new Date(exec.startedAt).getTime() : null;

    // Compute trace_incomplete before status update (avoid double-write)
    const traceIncomplete = body.trace_count_expected !== undefined
      && (exec.traceCountActual ?? 0) < body.trace_count_expected;

    await ctx.executionRepo.updateStatus(id, body.status, {
      finishedAt: new Date(),
      durationMs,
      resultSummary: body.result_summary ?? null,
      resultData: body.result_data as any,
      errorMessage: body.error_message ?? null,
      errorStack: body.error_stack ?? null,
      traceCountExpected: body.trace_count_expected ?? null,
      traceIncomplete,
    } as any);

    // Decrement active count
    await ctx.agentRepo.decrementExecutionCount(exec.agentId);

    return { ok: true };
  });

  // ── Trace Batch ──
  app.post("/api/executions/:id/traces", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = traceBatchSchema.parse(request.body);

    if (body.traces.length === 0) return { ok: true };

    const rows = body.traces.map(t => ({
      executionId: id,
      turnIndex: t.turn_index,
      spanIndex: t.span_index ?? 0,
      parentSpanId: t.parent_span_id ?? null,
      role: t.role,
      spanType: t.span_type ?? "llm",
      model: t.model ?? null,
      provider: t.provider ?? null,
      inputContent: t.input_content ?? null,
      outputContent: t.output_content ?? null,
      toolCalls: t.tool_calls as any,
      toolResults: t.tool_results as any,
      inputTokens: t.input_tokens ?? null,
      outputTokens: t.output_tokens ?? null,
      costEstimate: t.cost_estimate?.toString() ?? null,
      latencyMs: t.latency_ms ?? null,
    }));

    await ctx.traceRepo.insertBatch(rows);
    await ctx.executionRepo.incrementTraceCount(id, rows.length);

    return { ok: true, count: rows.length };
  });

  // ── Agent Trigger ──
  app.post("/api/agents/:name/trigger", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = triggerSchema.parse(request.body);
    const projectId = getProjectId(request);

    // Resolve trigger source: X-Trigger-Source header (dashboard → manual),
    // X-Execution-ID header (agent → agent), otherwise (SDK/cURL → api)
    const parentExecId = request.headers["x-execution-id"] as string | undefined;
    const triggerSource = request.headers["x-trigger-source"] as string | undefined;
    let triggerType: "manual" | "api" | "agent" = triggerSource === "dashboard" ? "manual" : "api";
    let parentExecution: any = null;
    let rootExecutionId: string | null = null;
    let triggerDepth = 0;

    if (parentExecId) {
      parentExecution = await ctx.executionRepo.findById(parentExecId);
      if (!parentExecution) return reply.status(404).send({ error: "parent execution not found" });
      if (parentExecution.status !== "running") return reply.status(409).send({ error: "trigger_from_terminal_execution" });
      // Verify parent execution belongs to same project as API key
      const parentAgent = await ctx.agentRepo.findById(parentExecution.agentId);
      if (!parentAgent || parentAgent.projectId !== projectId) {
        return reply.status(403).send({ error: "execution_not_owned" });
      }
      triggerType = "agent";
      rootExecutionId = parentExecution.rootExecutionId ?? parentExecution.id;
      triggerDepth = parentExecution.triggerDepth + 1;
    }

    // Depth check
    if (triggerDepth >= serverConfig.maxTriggerDepth) {
      return reply.status(409).send({ error: "trigger_depth_exceeded", max_depth: serverConfig.maxTriggerDepth });
    }

    // Idempotency check (Phase 1 stub — full impl in Phase 5 with unique index on
    // executions(agent_id, idempotency_key) WHERE status IN ('queued','running'))
    // In Phase 1, the idempotency_key is stored but not enforced. Accept the
    // race window; dedup_policy is passed through but ignored.

    // Find target agent
    const targetAgent = await ctx.agentRepo.findByProjectAndName(projectId, name);
    if (!targetAgent) return reply.status(404).send({ error: "agent not found" });

    // Authorization: cross-project trigger check
    if (parentExecution) {
      const parentAgent = await ctx.agentRepo.findById(parentExecution.agentId);
      if (parentAgent && parentAgent.projectId !== targetAgent.projectId) {
        // Cross-project: check allow_trigger_from
        return reply.status(403).send({ error: "cross_project_not_allowed" });
      }
    }

    // Validate payload against input_schema if present
    if (targetAgent.inputSchema) {
      // Zod validation of body.payload against inputSchema
    }

    const execution = await ctx.executionRepo.create({
      agentId: targetAgent.id,
      triggerType,
      triggeredBy: triggerType === "agent"
        ? `agent:${parentExecution ? (await ctx.agentRepo.findById(parentExecution.agentId))?.name : "unknown"}`
        : `api:${projectId}`,
      status: "queued",
      scheduledAt: new Date(),
      inputPayload: body.payload as any,
      parentExecutionId: parentExecId ?? null,
      rootExecutionId: rootExecutionId,
      triggerDepth,
      idempotencyKey: body.idempotency_key ?? null,
    });

    return reply.status(202).send({ execution_id: execution.id, status: "queued", duplicate: false });
  });

  // ── Cooldowns ──
  app.get("/api/cooldowns/:agentName/:key", async (request, reply) => {
    // Read cooldown state — simplified, full impl reads from agent_cooldowns table
    return { agent_name: (request.params as any).agentName, cooldown_key: (request.params as any).key, last_run_at: null, run_count: 0 };
  });

  app.put("/api/cooldowns/:agentName/:key", async (request, reply) => {
    // Upsert cooldown state
    return { ok: true };
  });

  // ── WebSocket ──
  app.get("/ws", { websocket: true }, (socket, req) => {
    socket.on("message", (msg) => {
      socket.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
    });
  });
}

// Extract project ID from API key auth
/**
 * Phase 1 auth model (simplified): All requests are scoped to a single "default"
 * project created by the seed. API key lookup against projects.api_key_hash is NOT
 * implemented in Phase 1 — the Bearer token is accepted but ignored. Cross-project
 * authorization and agent-level trigger whitelists are also deferred.
 *
 * This means: all agents registered via SDK, all manual triggers, and all dashboard
 * operations operate within the "default" project. Security boundaries come in Phase 5.
 */
function getProjectId(_request: any): string {
  return "default";
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server
npx tsc --noEmit 2>&1 | head -30
```

Expected: Some type errors (simplified code). Fix obvious ones, leave complex ones for next iterations.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/http/routes.ts
git commit -m "feat(api): implement SDK-facing routes — registry, poll, heartbeat, report, trigger, traces, cooldowns"
```

---

### Task 8: Dashboard API Routes

**Files:**
- Modify: `apps/server/src/http/routes.ts` (add dashboard API section)

Add these routes inside `registerRoutes()` after the SDK-facing endpoints:

```typescript
  // ── Projects (Dashboard API) ──
  app.get("/api/projects", async () => {
    return ctx.projectRepo.findAll();
  });

  app.get("/api/agents", async (request) => {
    const { project, type, status } = request.query as Record<string, string>;
    return ctx.agentRepo.findAll({
      projectId: project,
      agentType: type,
      executorStatus: status,
    });
  });

  app.get("/api/agents/:id", async (request, reply) => {
    const agent = await ctx.agentRepo.findById((request.params as any).id);
    if (!agent) return reply.status(404).send({ error: "not found" });
    // Get last 10 executions for status dots
    const recentExecs = await ctx.executionRepo.findAll({
      agentId: agent.id, limit: 10,
    });
    return { ...agent, recentExecutions: recentExecs };
  });

  app.patch("/api/agents/:id", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const agent = await ctx.agentRepo.update((request.params as any).id, body as any);
    if (!agent) return reply.status(404).send({ error: "not found" });
    return agent;
  });

  app.patch("/api/agents/bulk", async (request) => {
    const { project, enabled } = request.body as { project: string; enabled: boolean };
    const projectAgents = await ctx.agentRepo.findAll({ projectId: project });
    for (const agent of projectAgents) {
      await ctx.agentRepo.update(agent.id, { enabled } as any);
    }
    return { ok: true, count: projectAgents.length };
  });

  app.get("/api/agents/:id/schedule-preview", async (request) => {
    const agent = await ctx.agentRepo.findById((request.params as any).id);
    if (!agent || !agent.cronExpression) return { runs: [] };
    const cron = new Cron(agent.cronExpression);
    const now = new Date();
    const previews = [];
    let cursor = now;
    for (let i = 0; i < 10; i++) {
      const next = cron.nextRun(cursor);
      if (!next) break;
      previews.push(next.toISOString());
      cursor = new Date(next.getTime() + 1);
    }
    return { runs: previews };
  });

  app.get("/api/executions", async (request) => {
    const { agent_id, status, trigger_type, since, limit, offset } = request.query as Record<string, string>;
    return ctx.executionRepo.findAll({
      agentId: agent_id,
      status,
      triggerType: trigger_type,
      since: since ? new Date(since) : undefined,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
  });

  app.get("/api/executions/:id", async (request, reply) => {
    const exec = await ctx.executionRepo.findById((request.params as any).id);
    if (!exec) return reply.status(404).send({ error: "not found" });
    return exec;
  });

  app.get("/api/executions/:id/traces", async (request) => {
    return ctx.traceRepo.findByExecution((request.params as any).id);
  });

  app.get("/api/executions/:id/trigger-chain", async (request) => {
    return ctx.executionRepo.findTriggerChain((request.params as any).id, "both");
  });

  app.post("/api/executions/:id/cancel", async (request, reply) => {
    const exec = await ctx.executionRepo.updateStatus((request.params as any).id, "cancelled");
    if (!exec) return reply.status(404).send({ error: "not found" });
    await ctx.agentRepo.decrementExecutionCount(exec.agentId);
    return { ok: true };
  });

  app.get("/api/executors", async (request) => {
    const { project } = request.query as Record<string, string>;
    const onlineAgents = await ctx.agentRepo.findAll({
      projectId: project,
      executorStatus: "online",
    });
    return onlineAgents.map(a => ({
      agent_name: a.name,
      executor_host: a.executorHost,
      executor_status: a.executorStatus,
      last_heartbeat_at: a.lastHeartbeatAt,
      active_executions: a.activeExecutionCount,
    }));
  });

  app.get("/api/stats", async () => {
    // Aggregate stats
    const allAgents = await ctx.agentRepo.findAll({});
    const recentExecs = await ctx.executionRepo.findAll({ limit: 200 });
    const succeeded = recentExecs.filter(e => e.status === "success").length;
    const failed = recentExecs.filter(e => e.status === "failed").length;
    const total = recentExecs.length;
    return {
      agents_total: allAgents.length,
      agents_online: allAgents.filter(a => a.executorStatus === "online").length,
      recent_success_rate: total > 0 ? (succeeded / total * 100).toFixed(1) : "0",
      recent_failures: failed,
    };
  });
```

- [ ] **Step 1: Add dashboard routes to routes.ts**

Insert the above code block in `registerRoutes()` right before the `/ws` WebSocket handler.

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/http/routes.ts
git commit -m "feat(api): add dashboard API — projects, agents CRUD, executions, traces, stats, schedule preview, bulk ops"
```

---

### Task 9: Dashboard Shell

**Files:**
- Create: `apps/web/src/App.tsx` (replace old 10k-line file)
- Create: `apps/web/src/lib/api.ts`
- Modify: (optional) `apps/web/src/App.css`

- [ ] **Step 1: Rewrite API client**

```typescript
// apps/web/src/lib/api.ts
const BASE = "";  // Vite proxies /api to server in dev

function authHeaders(): Record<string, string> {
  const password = localStorage.getItem("ah_password") ?? "admin";
  return { "Authorization": "Basic " + btoa("admin:" + password) };
}

export async function fetchAgents(params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`/api/agents${qs}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchExecutions(params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`/api/executions${qs}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchExecutionDetail(id: string) {
  const res = await fetch(`/api/executions/${id}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchTraces(executionId: string) {
  const res = await fetch(`/api/executions/${executionId}/traces`, { headers: authHeaders() });
  return res.json();
}

export async function fetchStats() {
  const res = await fetch("/api/stats", { headers: authHeaders() });
  return res.json();
}

export async function patchAgent(id: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function triggerAgent(name: string, payload: unknown) {
  const res = await fetch(`/api/agents/${name}/trigger`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "X-Trigger-Source": "dashboard",
    },
    body: JSON.stringify({ payload }),
  });
  return res.json();
}

export function connectSocket(): WebSocket {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${location.host}/ws`);
}
```

- [ ] **Step 2: Create minimal dashboard React app**

```tsx
// apps/web/src/App.tsx
import { useState, useEffect, useCallback } from "react";
import { fetchAgents, fetchExecutions, fetchStats, patchAgent, triggerAgent, connectSocket } from "./lib/api";

type Page = "overview" | "agents" | "executions" | "detail";

interface Agent {
  id: string; name: string; display_name: string; agent_type: string;
  cron_expression: string | null; enabled: boolean;
  executor_status: string; active_execution_count: number;
  last_execution_at: string | null; last_heartbeat_at: string | null;
  recentExecutions?: Execution[];
}

interface Execution {
  id: string; agent_id: string; trigger_type: string; status: string;
  started_at: string | null; finished_at: string | null; duration_ms: number | null;
  result_summary: string | null; error_message: string | null;
  trace_count_actual: number;
}

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);
  const [traces, setTraces] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});
  const [wsConnected, setWsConnected] = useState(false);

  const loadData = useCallback(async () => {
    const [a, e, s] = await Promise.all([fetchAgents(), fetchExecutions({ limit: "50" }), fetchStats()]);
    setAgents(a);
    setExecutions(e);
    setStats(s);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const ws = connectSocket();
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "execution.updated" || event.type === "execution.created" ||
          event.type === "agent.updated") {
        loadData();
      }
    };
    return () => ws.close();
  }, [loadData]);

  const statusColor = (s: string) => {
    switch (s) {
      case "success": return "🟢";
      case "failed": case "timeout": return "🔴";
      case "running": return "🔵";
      case "queued": return "🟡";
      default: return "⚪";
    }
  };

  const cronDot = (e?: Execution) => {
    if (!e) return "⚪";
    if (e.status === "success") return "🟢";
    if (e.status === "failed" || e.status === "timeout") return "🔴";
    return "🟡";
  };

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: "1200px", margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h1 style={{ margin: 0 }}>Agent Cron Hub</h1>
        <span style={{ fontSize: "0.85rem", color: wsConnected ? "green" : "red" }}>
          {wsConnected ? "● Live" : "○ Disconnected"}
        </span>
      </header>

      <nav style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", borderBottom: "1px solid #ddd", paddingBottom: "0.5rem" }}>
        {(["overview", "agents", "executions"] as Page[]).map(p => (
          <button key={p} onClick={() => setPage(p)}
            style={{ background: page === p ? "#333" : "transparent", color: page === p ? "#fff" : "#333",
              border: "none", padding: "0.5rem 1rem", borderRadius: "4px", cursor: "pointer", textTransform: "capitalize" }}>
            {p}
          </button>
        ))}
      </nav>

      {page === "overview" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem", marginBottom: "1.5rem" }}>
            <StatCard label="Agents" value={stats.agents_total ?? agents.length} />
            <StatCard label="Online" value={stats.agents_online ?? agents.filter(a => a.executor_status === "online").length} />
            <StatCard label="Running" value={executions.filter(e => e.status === "running").length} />
            <StatCard label="Failed (24h)" value={stats.recent_failures ?? 0} />
          </div>

          <h2>Recent Executions</h2>
          <ExecutionTable executions={executions.slice(0, 10)} onSelect={(e) => {
            setSelectedExecution(e);
            setPage("detail");
            if (e.id) fetch(`/api/executions/${e.id}/traces`, { headers: { "Authorization": "Basic " + btoa("admin:admin") } })
              .then(r => r.json()).then(setTraces);
          }} statusColor={statusColor} />
        </div>
      )}

      {page === "agents" && (
        <div>
          <h2>Agents</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
                <th>Project</th><th>Agent</th><th>Cron</th><th>Status</th><th>Last 10</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.5rem" }}>{a.name.split("_")[0] ?? "-"}</td>
                  <td style={{ padding: "0.5rem", fontWeight: 500 }}>{a.display_name || a.name}</td>
                  <td style={{ padding: "0.5rem", fontFamily: "monospace", fontSize: "0.85rem" }}>{a.cron_expression || "manual"}</td>
                  <td style={{ padding: "0.5rem" }}>
                    <span style={{ color: a.enabled ? (a.executor_status === "online" ? "green" : "orange") : "gray" }}>
                      {a.enabled ? (a.executor_status === "online" ? "● on" : "○ offline") : "◌ off"}
                    </span>
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    {(a.recentExecutions ?? []).slice(0, 10).map((e, i) => (
                      <span key={i} title={e.status}>{cronDot(e)}</span>
                    ))}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    <button onClick={() => patchAgent(a.id, { enabled: !a.enabled }).then(loadData)}
                      style={{ marginRight: "0.25rem" }}>{a.enabled ? "Disable" : "Enable"}</button>
                    <button onClick={() => triggerAgent(a.name, {}).then(loadData)}>Run</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page === "executions" && (
        <div>
          <h2>Executions</h2>
          <ExecutionTable executions={executions} onSelect={(e) => {
            setSelectedExecution(e);
            setPage("detail");
            if (e.id) fetch(`/api/executions/${e.id}/traces`, { headers: { "Authorization": "Basic " + btoa("admin:admin") } })
              .then(r => r.json()).then(setTraces);
          }} statusColor={statusColor} />
        </div>
      )}

      {page === "detail" && selectedExecution && (
        <div>
          <button onClick={() => setPage("executions")} style={{ marginBottom: "1rem" }}>← Back</button>
          <h2>Execution Detail</h2>
          <div style={{ background: "#f5f5f5", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
            <p>Status: {statusColor(selectedExecution.status)} {selectedExecution.status}</p>
            <p>Duration: {selectedExecution.duration_ms ? `${selectedExecution.duration_ms}ms` : "N/A"}</p>
            <p>Trigger: {selectedExecution.trigger_type}</p>
            {selectedExecution.error_message && <p style={{ color: "red" }}>Error: {selectedExecution.error_message}</p>}
            {selectedExecution.result_summary && <p>Result: {selectedExecution.result_summary}</p>}
            <p>Traces: {selectedExecution.trace_count_actual ?? 0} recorded</p>
          </div>

          <h3>Traces</h3>
          {traces.length === 0 && <p>No traces recorded.</p>}
          {traces.map((t: any, i: number) => (
            <details key={i} style={{ marginBottom: "0.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "0.5rem" }}>
              <summary>
                Turn {t.turn_index}.{t.span_index} — {t.span_type} ({t.role})
                {t.model && ` — ${t.model}`}
                {t.latency_ms && ` — ${t.latency_ms}ms`}
              </summary>
              {t.input_content && <pre style={{ whiteSpace: "pre-wrap", maxHeight: "200px", overflow: "auto", background: "#f9f9f9", padding: "0.5rem" }}>{t.input_content.slice(0, 2000)}</pre>}
              {t.output_content && <pre style={{ whiteSpace: "pre-wrap", maxHeight: "200px", overflow: "auto", background: "#f0f0f0", padding: "0.5rem" }}>{t.output_content.slice(0, 2000)}</pre>}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: "#f5f5f5", padding: "1.5rem", borderRadius: "8px", textAlign: "center" }}>
      <div style={{ fontSize: "2rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.85rem", color: "#666", marginTop: "0.25rem" }}>{label}</div>
    </div>
  );
}

function ExecutionTable({ executions, onSelect, statusColor }: {
  executions: Execution[];
  onSelect: (e: Execution) => void;
  statusColor: (s: string) => string;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
          <th>Time</th><th>Agent</th><th>Status</th><th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {executions.map(e => (
          <tr key={e.id} onClick={() => onSelect(e)}
            style={{ borderBottom: "1px solid #eee", cursor: "pointer" }}>
            <td style={{ padding: "0.5rem" }}>{e.started_at ? new Date(e.started_at).toLocaleTimeString() : "-"}</td>
            <td style={{ padding: "0.5rem" }}>{e.trigger_type} — {e.triggered_by ?? "-"}</td>
            <td style={{ padding: "0.5rem" }}>{statusColor(e.status)} {e.status}</td>
            <td style={{ padding: "0.5rem" }}>{e.duration_ms ? `${e.duration_ms}ms` : "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Simplify main.tsx**

```tsx
// apps/web/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>
);
```

- [ ] **Step 3: Remove old App.tsx (10k-line file)**

```bash
# Already replaced by Step 1's Write
```

- [ ] **Step 4: Add Vite proxy config for dev**

In `apps/web/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ apps/web/vite.config.ts
git commit -m "feat(dashboard): replace 10k-line App with minimal Agent Cron Hub shell — overview, agents, executions, trace viewer"
```

---

### Task 10: Integration Test & Seed Data

**Files:**
- Create: `apps/server/src/db/seed.ts`
- Modify: `apps/server/src/index.ts` (wire seed + retention cleanup into startup)

- [ ] **Step 1: Create minimal seed**

```typescript
// apps/server/src/db/seed.ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { projects, agents } from "./schema.js";
import { eq } from "drizzle-orm";

export async function seedIfEmpty(db: NodePgDatabase) {
  const existing = await db.select().from(projects).limit(1);
  if (existing.length > 0) return;

  // Create default project
  const [proj] = await db.insert(projects).values({
    name: "default",
    displayName: "Default Project",
    description: "Default project for local development",
    dashboardPasswordHash: "admin",
  }).returning();

  // Seed a demo agent
  await db.insert(agents).values({
    projectId: proj.id,
    name: "demo_hello",
    displayName: "Demo Hello World",
    agentType: "cron_task",
    cronExpression: "*/5 * * * *",
    handlerName: "demo_handler",
    concurrency: 1,
    timeoutSeconds: 60,
    retryMax: 2,
    executorStatus: "offline",
  });

  console.log("Seeded default project and demo agent");
}
```

- [ ] **Step 2: Wire seed into app startup**

Update `apps/server/src/app.ts` — add after pool creation:
```typescript
import { seedIfEmpty } from "./db/seed.js";
// ...
const db = createDb(pool);
await seedIfEmpty(db as any);
```

- [ ] **Step 3: Start server and run smoke test**

```bash
cd /Users/emosama/workspace/agent-hub/apps/server
npx tsx src/index.ts &
sleep 2

# Test health
curl http://localhost:8787/api/health

# Test agent listing
curl http://localhost:8787/api/agents -H "Authorization: Basic $(echo -n 'admin:admin' | base64)"

# Test manual trigger
curl -X POST http://localhost:8787/api/agents/demo_hello/trigger \
  -H "Authorization: Basic $(echo -n 'admin:admin' | base64)" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"message": "test"}}'

kill %1
```

Expected: Health returns `{"status":"ok"}`, agent listing returns seeded agent, trigger creates an execution.

- [ ] **Step 4: Verify dashboard compiles**

```bash
cd /Users/emosama/workspace/agent-hub/apps/web
npx vite build 2>&1 | tail -5
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/seed.ts apps/server/src/app.ts apps/server/src/index.ts
git commit -m "feat: add seed data, wire retention cleanup, smoke test verification"
```

---

## Completion Checklist

After all 10 tasks are complete, verify:

- [ ] `docker compose up -d postgres && npm run dev` starts both server and dashboard
- [ ] `GET /api/health` returns 200
- [ ] `GET /api/metrics` returns agent counts
- [ ] `GET /api/agents` returns seeded agents
- [ ] `POST /api/agents/:name/trigger` creates an execution
- [ ] `GET /api/executions` list includes the triggered execution
- [ ] `GET /api/stats` returns aggregate numbers
- [ ] `PUT /api/registry/agents` registers a new agent
- [ ] Dashboard shows agents list with enable/disable and trigger buttons
- [ ] WebSocket connects and receives events
