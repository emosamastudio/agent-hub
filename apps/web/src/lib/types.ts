// apps/web/src/lib/types.ts

export type Page = "overview" | "agents" | "executions" | "detail" | "agent-detail";

export type DashboardLanguage = "zh" | "en";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "error";

export type MisfirePolicy = "fire_once" | "fire_all" | "drop";

export interface Project {
  id: string;
  name: string;
  displayName: string;
  status?: string;
  description?: string | null;
  workspacePath?: string | null;
  allowTriggerFrom?: string[];
  triggerRateLimitPerSec?: number;
  costConfig?: Record<string, unknown>;
  providerConfig?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  displayName: string;
  agentType: string;
  cronExpression: string | null;
  enabled: boolean;
  executorStatus: string;
  activeExecutionCount: number;
  lastExecutionAt: string | null;
  lastHeartbeatAt: string | null;
  archivedAt?: string | null;
  misfirePolicy?: MisfirePolicy;
  concurrency?: number;
  maxPendingQueue?: number;
  timeoutSeconds?: number;
  retryMax?: number;
  retryBackoffBaseMs?: number;
  handlerName?: string | null;
  executorHost?: string | null;
  idempotencyWindowSeconds?: number;
  maxTurns?: number | null;
  maxCostUsd?: string | number | null;
  recentExecutions?: Execution[];
  description?: string | null;
  inputSchema?: unknown;
  allowTriggerBy?: unknown;
  labels?: Record<string, unknown>;
  providerConfig?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  projectName?: string;
  projectDisplayName?: string;
}

export interface SchedulerAgentStatus {
  id: string;
  projectId?: string;
  name: string;
  displayName?: string;
  enabled: boolean;
  executorStatus: string;
  cronExpression: string | null;
  queuedCount: number;
  runningCount: number;
  pendingCount: number;
  activeExecutionCount: number;
  concurrency: number;
  capacityAvailable: number;
  maxPendingQueue: number | null;
  queueAvailable: number | null;
  dispatchState: string;
  scheduleState: string;
  dueRunAt: string | null;
  nextRunAt: string | null;
  cronError?: string | null;
  agentType?: string;
  misfirePolicy?: string;
  queueDepth?: number;
  scheduledCount?: number;
  lastHeartbeatAt?: string | null;
  lastExecutionAt?: string | null;
  runningExecutions?: Array<{ id: string; status: string; startedAt?: string }>;
}

export interface Execution {
  id: string;
  agentId: string;
  triggerType: string;
  status: string;
  triggeredBy: string | null;
  scheduledAt?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  errorMessage: string | null;
  inputPayload?: Record<string, unknown> | null;
  traceCountActual: number;
  progressPercent?: number | null;
  progressMessage?: string | null;
  createdAt?: string | null;
  parentExecutionId?: string | null;
  rootExecutionId?: string | null;
  triggerDepth?: number;
  idempotencyKey?: string | null;
  lastActivityAt?: string | null;
  resultData?: unknown;
  errorStack?: string | null;
  traceCountExpected?: number | null;
  traceIncomplete?: boolean;
  retryCount?: number;
  retryOf?: string | null;
  executorHost?: string | null;
  agentName?: string;
  projectName?: string;
  projectId?: string;
  name?: string;
}

export interface DashboardStats {
  agents_total?: number;
  agentsTotal?: number;
  agents_online?: number;
  agentsOnline?: number;
  recent_failures?: number;
  recentFailures?: number;
  recent_success_rate?: string;
  recentSuccessRate?: string;
}

export interface AlertEntry {
  id: number;
  ruleName: string;
  severity: string;
  agentId: string | null;
  agentName: string | null;
  agentDisplayName: string | null;
  message: string;
  context: Record<string, unknown> | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  createdAt: string | null;
  rule_name?: string;
  agent_id?: string | null;
  created_at?: string;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
}

export interface TraceSpan {
  turnIndex?: number;
  turn_index?: number;
  spanIndex?: number;
  span_index?: number;
  role?: string;
  spanType?: string;
  span_type?: string;
  model?: string | null;
  latencyMs?: number | null;
  metadata?: Record<string, unknown> | null;
  latency_ms?: number | null;
  inputContent?: string | null;
  input_content?: string | null;
  outputContent?: string | null;
  output_content?: string | null;
  inputTokens?: number | null;
  input_tokens?: number | null;
  outputTokens?: number | null;
  output_tokens?: number | null;
  status?: string;
  id?: string;
  executionId?: string;
  parentSpanId?: string | null;
  provider?: string | null;
  toolCalls?: unknown;
  tool_calls?: unknown;
  toolResults?: unknown;
  tool_results?: unknown;
  costEstimate?: string | null;
  createdAt?: string;
  created_at?: string;
}

export interface SchedulerRuntimeStats {
  running?: boolean;
  tickMs?: number;
  startedAt?: string | null;
  started_at?: string | null;
  tickCount?: number;
  tick_count?: number;
  overlapSkippedCount?: number;
  overlap_skipped_count?: number;
  lockSkippedCount?: number;
  lock_skipped_count?: number;
  lastTickDurationMs?: number;
  last_tick_duration_ms?: number;
  lastTickErrorCount?: number;
  last_tick_error_count?: number;
  lastTickStepErrors?: Array<{ step: string; message: string }>;
  last_tick_step_errors?: Array<{ step: string; message: string }>;
}

export interface ExecutionFilterValues {
  projectId?: string;
  agentId?: string;
  statuses?: string[];
  triggerType?: string;
  since?: string;
  until?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface SavedView {
  name: string;
  filters: ExecutionFilterValues;
  createdAt: string;
}

export interface Round {
  turnIndex: number;
  spans: TraceSpan[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalLatencyMs: number;
}

export type { Round as TraceRound };
