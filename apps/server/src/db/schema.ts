import {
  pgTable, uuid, text, integer, timestamp, boolean,
  jsonb, numeric, pgEnum, bigserial, primaryKey, date,
  index, uniqueIndex,
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
  providerConfig: jsonb("provider_config"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  apiKeyHashIdx: index("idx_projects_api_key_hash").on(table.apiKeyHash),
}));

// --- agents ---
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  agentType: text("agent_type").notNull(),
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
  providerConfig: jsonb("provider_config"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  lastExecutionAt: timestamp("last_execution_at", { withTimezone: true }),
  activeExecutionCount: integer("active_execution_count").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  projectNameIdx: uniqueIndex("idx_agents_project_name").on(table.projectId, table.name),
  archivedAtIdx: index("idx_agents_archived_at").on(table.archivedAt),
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
  progressPercent: integer("progress_percent"),
  progressMessage: text("progress_message"),
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
}, (table) => ({
  statusScheduledIdx: index("idx_executions_status_scheduled_at").on(table.status, table.scheduledAt),
  agentStatusIdx: index("idx_executions_agent_status").on(table.agentId, table.status),
  agentIdempotencyIdx: index("idx_executions_agent_idempotency_created_at").on(table.agentId, table.idempotencyKey, table.createdAt),
  retryOfIdx: index("idx_executions_retry_of").on(table.retryOf),
}));

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
}, (table) => ({
  executionIdx: index("idx_traces_execution_id").on(table.executionId),
}));

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
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: text("acknowledged_by"),
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

// --- proxy_tokens ---
export const proxyTokens = pgTable("proxy_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  executionId: uuid("execution_id").notNull().references(() => executions.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tokenHashIdx: index("idx_proxy_tokens_token_hash").on(table.tokenHash),
  expiresAtIdx: index("idx_proxy_tokens_expires_at").on(table.expiresAt),
  executionIdIdx: index("idx_proxy_tokens_execution_id").on(table.executionId),
}));
