export type AgentType = "cron_task" | "llm_agent";

export type MisfirePolicy = "fire_once" | "fire_all" | "drop";

export type ExecutorStatus = "online" | "offline";

export type TriggerType = "cron" | "manual" | "api" | "agent" | "retry";

export type ExecutionStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "cancelled";

export type TraceRole = "system" | "user" | "assistant" | "tool";

export interface ProjectRecord {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  workspacePath: string | null;
  status: "active" | "disabled" | string;
  allowTriggerFrom: string[] | null;
  triggerRateLimitPerSec: number | null;
  costConfig: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSpec {
  name: string;
  displayName: string;
  agentType: AgentType;
  cron?: string;
  handler?: string;
  inputSchema?: Record<string, unknown>;
  concurrency?: number;
  timeoutSeconds?: number;
  retryMax?: number;
  retryBackoffBaseMs?: number;
  maxPendingQueue?: number;
  misfirePolicy?: MisfirePolicy;
  maxTurns?: number;
  maxCostUsd?: number;
  executorHost?: string;
  allowTriggerBy?: Record<string, unknown> | null;
  labels?: Record<string, string>;
}

export interface AgentRecord {
  id: string;
  projectId: string;
  name: string;
  displayName: string;
  description: string | null;
  agentType: AgentType | string;
  cronExpression: string | null;
  enabled: boolean;
  misfirePolicy: MisfirePolicy | string;
  concurrency: number;
  maxPendingQueue: number;
  timeoutSeconds: number;
  retryMax: number;
  retryBackoffBaseMs: number;
  maxTurns: number | null;
  maxCostUsd: string | null;
  handlerName: string | null;
  executorHost: string | null;
  executorStatus: ExecutorStatus | string;
  inputSchema: Record<string, unknown> | null;
  allowTriggerBy: Record<string, unknown> | null;
  idempotencyWindowSeconds: number;
  labels: Record<string, string> | null;
  lastHeartbeatAt: string | null;
  lastExecutionAt: string | null;
  activeExecutionCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPatch {
  displayName?: string;
  description?: string | null;
  cronExpression?: string | null;
  enabled?: boolean;
  misfirePolicy?: MisfirePolicy;
  concurrency?: number;
  maxPendingQueue?: number;
  timeoutSeconds?: number;
  retryMax?: number;
  retryBackoffBaseMs?: number;
  maxTurns?: number | null;
  maxCostUsd?: number | null;
  handlerName?: string | null;
  executorHost?: string | null;
  executorStatus?: ExecutorStatus;
  inputSchema?: Record<string, unknown> | null;
  allowTriggerBy?: Record<string, unknown> | null;
  idempotencyWindowSeconds?: number;
  labels?: Record<string, string>;
}

export interface TriggerRequest {
  payload?: Record<string, unknown>;
  idempotency_key?: string;
  dedup_policy?: "skip_if_running" | "skip_if_exists" | "allow_duplicate";
}

export interface TriggerResponse {
  execution_id: string;
  status: ExecutionStatus;
  duplicate: boolean;
}

export interface ExecutionRecord {
  id: string;
  agentId: string;
  triggerType: TriggerType;
  triggeredBy: string | null;
  parentExecutionId: string | null;
  rootExecutionId: string | null;
  triggerDepth: number;
  idempotencyKey: string | null;
  status: ExecutionStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  lastActivityAt: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
  inputPayload: Record<string, unknown> | null;
  resultSummary: string | null;
  resultData: Record<string, unknown> | null;
  errorMessage: string | null;
  errorStack: string | null;
  traceCountExpected: number | null;
  traceCountActual: number | null;
  traceIncomplete: boolean | null;
  retryCount: number;
  retryOf: string | null;
  executorHost: string | null;
  createdAt: string;
}

export interface PolledExecution extends ExecutionRecord {
  agentName: string;
  handlerName: string | null;
  timeoutSeconds: number;
}

export interface ExecutionReport {
  status: "success" | "failed";
  result_summary?: string;
  result_data?: Record<string, unknown>;
  error_message?: string;
  error_stack?: string;
  trace_count_expected?: number;
}

export interface TraceSpan {
  id?: string;
  executionId?: string;
  turn_index?: number;
  turnIndex?: number;
  span_index?: number;
  spanIndex?: number;
  parent_span_id?: string;
  parentSpanId?: string;
  role: TraceRole;
  span_type?: string;
  spanType?: string;
  model?: string | null;
  provider?: string | null;
  input_content?: string | null;
  inputContent?: string | null;
  output_content?: string | null;
  outputContent?: string | null;
  tool_calls?: unknown;
  toolCalls?: unknown;
  tool_results?: unknown;
  toolResults?: unknown;
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cost_estimate?: number;
  costEstimate?: number | string;
  latency_ms?: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface TraceBatchRequest {
  traces: TraceSpan[];
}

export interface CooldownRecord {
  agent_name: string;
  cooldown_key: string;
  last_run_at: string | null;
  run_count: number;
}

export interface DashboardStats {
  agents_total: number;
  agents_online: number;
  recent_success_rate: string;
  recent_failures: number;
}

export interface ExecutorSummary {
  agent_name: string;
  executor_host: string | null;
  executor_status: ExecutorStatus | string;
  last_heartbeat_at: string | null;
  active_executions: number;
}
