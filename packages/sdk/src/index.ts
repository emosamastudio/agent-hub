// packages/sdk/src/index.ts
import { spawn } from "node:child_process";

export interface AgentHubConfig {
  serverUrl: string;
  serverUrls?: string[];  // HA: randomly pick one per poll
  project: string;
  apiKey?: string;
}

export interface AgentSpec {
  name: string;
  displayName: string;
  description: string;
  agentType: 'cron_task' | 'llm_agent';
  cron?: string;
  handler: string;
  inputSchema?: Record<string, unknown>;
  concurrency?: number;
  timeoutSeconds?: number;
  retryMax?: number;
  maxPendingQueue?: number;
  misfirePolicy?: 'fire_once' | 'fire_all' | 'drop';
  executorHost?: string;
  labels?: Record<string, string>;
}

interface Execution {
  id: string;
  agentId: string;
  agentName?: string;
  handlerName?: string | null;
  triggerType: string;
  status: string;
  inputPayload: Record<string, unknown>;
  timeoutSeconds?: number;
}

interface TraceSpan {
  turn_index: number;
  span_index?: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  span_type?: string;
  model?: string;
  provider?: string;
  input_content?: string;
  output_content?: string;
  tool_calls?: unknown;
  tool_results?: unknown;
  input_tokens?: number;
  output_tokens?: number;
  cost_estimate?: number;
  latency_ms?: number;
  metadata?: Record<string, unknown>;
}

interface HeartbeatResponse {
  cancelled_execution_ids?: string[];
}

export type AgentHubDedupPolicy = 'skip_if_running' | 'skip_if_exists' | 'allow_duplicate';
export type AgentHubArchiveFilter = 'active' | 'include' | 'only';

export interface AgentHubControlConfig {
  serverUrl: string;
  apiKey?: string;
  dashboardUsername?: string;
  dashboardPassword?: string;
}

export interface AgentHubCreateProjectInput {
  name: string;
  displayName?: string;
  description?: string;
  apiKey?: string;
}

export interface AgentHubProjectRecord {
  id: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type AgentHubEnsureProjectResult =
  | { created: false; project: AgentHubProjectRecord }
  | { created: true; project: AgentHubProjectRecord; api_key: string };

export interface AgentHubListAgentsQuery {
  project?: string;
  type?: 'cron_task' | 'llm_agent' | string;
  status?: string;
  archived?: AgentHubArchiveFilter;
}

export interface AgentHubAgentTargetOptions {
  project?: string;
}

export interface AgentHubGetAgentOptions extends AgentHubAgentTargetOptions {
  includeArchived?: boolean;
}

export interface AgentHubSchedulerStatusQuery {
  project?: string;
  agent_id?: string;
}

export interface AgentHubListExecutorsQuery {
  project?: string;
}

export interface AgentHubListAlertsQuery {
  limit?: number;
  includeAcknowledged?: boolean;
}

export interface AgentHubAcknowledgeAlertOptions {
  acknowledgedBy?: string;
}

export interface AgentHubListExecutionsQuery {
  project?: string;
  agent?: string;
  agent_id?: string;
  status?: string;
  trigger_type?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface AgentHubTriggerOptions {
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  dedupPolicy?: AgentHubDedupPolicy;
}

export interface AgentHubTriggerResult {
  execution_id: string;
  status: string;
  duplicate?: boolean;
  [key: string]: unknown;
}

export interface AgentHubSchedulePreviewOptions extends AgentHubAgentTargetOptions {
  limit?: number;
}

export interface AgentHubDrainAgentOptions extends AgentHubAgentTargetOptions {
  cancelRunning?: boolean;
}

export interface AgentHubDrainProjectOptions {
  cancelRunning?: boolean;
}

export interface AgentHubWaitExecutionOptions {
  timeoutMs?: number;
  intervalMs?: number;
  requireSuccess?: boolean;
}

export interface AgentHubTriggerAndWaitResult {
  trigger: AgentHubTriggerResult;
  execution: unknown;
}

export interface AgentHubInspectExecutionResult {
  execution: unknown;
  traces: unknown[];
  triggerChain: unknown[];
}

export interface AgentHubRunCanaryOptions extends AgentHubTriggerOptions, AgentHubWaitExecutionOptions {
  project?: string;
}

export interface AgentHubRunCanaryResult {
  preflight: AgentHubDoctorReport;
  trigger: AgentHubTriggerResult;
  execution: unknown;
  postflight: AgentHubDoctorReport;
}

export interface AgentHubSchedulerRuntimeMetrics {
  running: boolean;
  tick_ms: number;
  started_at: string | null;
  stopped_at: string | null;
  tick_in_progress: boolean;
  tick_count: number;
  overlap_skipped_count: number;
  lock_skipped_count: number;
  last_tick_started_at: string | null;
  last_tick_finished_at: string | null;
  last_tick_duration_ms: number | null;
  last_tick_error_count: number;
  last_tick_step_errors: Array<{ step: string; message: string }>;
}

export interface AgentHubMetricsSnapshot {
  agents_total: number;
  agents_enabled: number;
  agents_disabled: number;
  agents_online: number;
  agents_offline: number;
  executions_queued: number;
  executions_running: number;
  executions_success: number;
  executions_failed: number;
  executions_timeout: number;
  executions_cancelled: number;
  executions_terminal: number;
  alerts_active: number;
  scheduler: AgentHubSchedulerRuntimeMetrics;
}

export interface AgentHubDoctorOptions {
  project?: string;
}

export type AgentHubDoctorStatus = 'ok' | 'warning' | 'error';

export interface AgentHubDoctorCheck {
  name: string;
  status: AgentHubDoctorStatus;
  message?: string;
  details?: unknown;
}

export interface AgentHubDoctorReport {
  ok: boolean;
  generatedAt: string;
  serverUrl: string;
  project?: {
    requested?: string;
    found: boolean;
    id?: string;
    name?: string;
    displayName?: string | null;
  };
  summary: {
    errors: number;
    warnings: number;
  };
  checks: AgentHubDoctorCheck[];
  health?: unknown;
  ready?: unknown;
  metrics?: unknown;
  projects?: unknown[];
  agents?: unknown[];
  executors?: unknown[];
  alerts?: unknown[];
}

export interface AgentHubOpsStatusOptions {
  project?: string;
  alertLimit?: number;
  executionLimit?: number;
  failOnWarning?: boolean;
}

export interface AgentHubTraceCoverageSummary {
  status: 'ok' | 'warning' | 'skipped';
  sampled: number;
  withTraces: number;
  withoutTraces: number;
  message: string;
}

export interface AgentHubObserveOpsStatusOptions extends AgentHubOpsStatusOptions {
  iterations?: number;
  intervalMs?: number;
}

export interface AgentHubOpsStatusSummary {
  errors: number;
  warnings: number;
  schedulerRunning: boolean | null;
  agentsTotal: number;
  agentsOnline: number;
  executorsOnline: number;
  activeAlerts: number;
  executionsQueued: number | null;
  executionsRunning: number | null;
  executionsFailed: number | null;
  executionsTimeout: number | null;
}

export interface AgentHubOpsStatusReport {
  ok: boolean;
  generatedAt: string;
  serverUrl: string;
  project?: AgentHubDoctorReport["project"];
  summary: AgentHubOpsStatusSummary;
  doctor: AgentHubDoctorReport;
  metrics?: unknown;
  scheduler?: unknown;
  agents: unknown[];
  executors: unknown[];
  executions: {
    queued: unknown[];
    running: unknown[];
    success: unknown[];
    failed: unknown[];
    timeout: unknown[];
  };
  traceCoverage?: AgentHubTraceCoverageSummary;
  alerts: unknown[];
}

export interface AgentHubObserveOpsStatusReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  iterations: number;
  failedIterations: number;
  snapshots: AgentHubOpsStatusReport[];
}

export interface AgentHubRecoveryPlanOptions {
  project?: string;
  backupDir?: string;
  backupFile?: string;
  serviceName?: string;
  envFile?: string;
  databaseUrlConfigured?: boolean;
  executionLimit?: number;
}

export interface AgentHubRecoveryPlan {
  generatedAt: string;
  serverUrl: string;
  project?: string;
  databaseUrlConfigured: boolean;
  backup: {
    outputPath: string;
    commands: string[];
  };
  upgrade: {
    commands: string[];
  };
  rollback: {
    commands: string[];
  };
  verify: {
    commands: string[];
  };
  warnings: string[];
}

export interface AgentHubRecoveryDrillPlanOptions extends AgentHubRecoveryPlanOptions {
  restoreDatabaseEnvVar?: string;
  restoreDatabaseUrlConfigured?: boolean;
}

export interface AgentHubRecoveryDrillPlan {
  generatedAt: string;
  serverUrl: string;
  project?: string;
  databaseUrlConfigured: boolean;
  restoreDatabaseUrlConfigured: boolean;
  restoreDatabaseEnvVar: string;
  preflight: {
    commands: string[];
  };
  backup: {
    outputPath: string;
    commands: string[];
  };
  restore: {
    commands: string[];
  };
  verify: {
    commands: string[];
  };
  warnings: string[];
}

export type AgentHubRecoveryDrillStage = "preflight" | "backup" | "restore" | "verify";

export interface AgentHubRecoveryDrillCommandContext {
  stage: AgentHubRecoveryDrillStage;
  timeoutMs: number;
}

export interface AgentHubRecoveryDrillCommandResult {
  stage: AgentHubRecoveryDrillStage;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type AgentHubRecoveryDrillCommandRunner = (
  command: string,
  context: AgentHubRecoveryDrillCommandContext,
) => Promise<AgentHubRecoveryDrillCommandResult>;

export interface AgentHubRunRecoveryDrillOptions extends AgentHubRecoveryDrillPlanOptions {
  confirmRestoreDatabaseReset?: boolean;
  commandTimeoutMs?: number;
  commandRunner?: AgentHubRecoveryDrillCommandRunner;
}

export interface AgentHubRunRecoveryDrillReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  plan: AgentHubRecoveryDrillPlan;
  commands: AgentHubRecoveryDrillCommandResult[];
  failedCommand?: AgentHubRecoveryDrillCommandResult;
}

export interface AgentHubReleaseCheckOptions extends AgentHubRunRecoveryDrillOptions, AgentHubOpsStatusOptions {
  includeRecoveryDrill?: boolean;
  canaryAgent?: string;
  canaryPayload?: Record<string, unknown>;
  canaryTimeoutMs?: number;
  canaryIntervalMs?: number;
  observeIterations?: number;
  observeIntervalMs?: number;
  skipObserve?: boolean;
}

export interface AgentHubReleaseCheckStep {
  name: "doctor" | "ops_status" | "recovery_drill" | "canary" | "observe";
  ok: boolean;
  skipped: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentHubReleaseCheckReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  serverUrl: string;
  project?: string;
  steps: AgentHubReleaseCheckStep[];
}

export interface AgentHubDrainAgentResult {
  ok: true;
  agent_id: string;
  cancelled_queued: number;
  cancelled_running: number;
  active_execution_count: number;
}

export interface AgentHubDrainProjectResult {
  ok: true;
  project_id: string;
  agents_drained: number;
  cancelled_queued: number;
  cancelled_running: number;
  active_execution_count: number;
}

export interface AgentHubSetProjectEnabledResult {
  ok: true;
  count: number;
}

interface AgentHubAgentRecord {
  id: string;
  name?: string;
  projectId?: string;
}

export type AgentHubAgentType = 'cron_task' | 'llm_agent';
export type AgentHubMisfirePolicy = 'fire_once' | 'fire_all' | 'drop';

export interface AgentHubCreateAgentInput {
  project?: string;
  projectId?: string;
  name: string;
  displayName: string;
  description: string;
  agentType?: AgentHubAgentType;
  cronExpression?: string | null;
  handlerName?: string | null;
  enabled?: boolean;
  misfirePolicy?: AgentHubMisfirePolicy;
  concurrency?: number;
  maxPendingQueue?: number;
  timeoutSeconds?: number;
  retryMax?: number;
  retryBackoffBaseMs?: number;
  maxTurns?: number | null;
  maxCostUsd?: number | null;
  inputSchema?: Record<string, unknown> | null;
  allowTriggerBy?: Record<string, unknown> | null;
  idempotencyWindowSeconds?: number;
  labels?: Record<string, string>;
}

export interface AgentHubUpdateAgentInput {
  displayName?: string;
  description?: string | null;
  cronExpression?: string | null;
  enabled?: boolean;
  misfirePolicy?: AgentHubMisfirePolicy;
  concurrency?: number;
  maxPendingQueue?: number;
  timeoutSeconds?: number;
  retryMax?: number;
  retryBackoffBaseMs?: number;
  maxTurns?: number | null;
  maxCostUsd?: number | null;
  handlerName?: string | null;
  executorHost?: string | null;
  executorStatus?: 'online' | 'offline';
  inputSchema?: Record<string, unknown> | null;
  allowTriggerBy?: Record<string, unknown> | null;
  idempotencyWindowSeconds?: number;
  labels?: Record<string, string>;
}

type QueryValue = string | number | boolean | null | undefined;
type AuthMode = 'none' | 'dashboard' | 'apiKey';

const terminalExecutionStatuses = new Set(['success', 'failed', 'timeout', 'cancelled']);

function executionStatus(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const status = (record as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

function triggerExecutionId(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const executionId = (record as { execution_id?: unknown }).execution_id;
  return typeof executionId === 'string' && executionId.length > 0 ? executionId : null;
}

function recordStatus(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const status = (record as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

function projectRecordMatches(record: AgentHubProjectRecord, project: string): boolean {
  return record.id === project || record.name === project;
}

function looksLikeDirectAgentId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberRecordField(record: unknown, key: string): number | null {
  const value = objectRecord(record)?.[key];
  return typeof value === 'number' ? value : null;
}

function numberRecordFieldAny(record: unknown, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberRecordField(record, key);
    if (value !== null) return value;
  }
  return null;
}

function summarizeTraceCoverage(successfulExecutions: unknown[]): AgentHubTraceCoverageSummary {
  const sampled = successfulExecutions.length;
  if (sampled === 0) {
    return {
      status: 'skipped',
      sampled,
      withTraces: 0,
      withoutTraces: 0,
      message: 'No recent successful executions sampled',
    };
  }

  const withTraces = successfulExecutions.filter((execution) => (
    (numberRecordFieldAny(execution, ['traceCountActual', 'trace_count_actual']) ?? 0) > 0
  )).length;
  const withoutTraces = sampled - withTraces;

  if (withTraces === 0) {
    return {
      status: 'warning',
      sampled,
      withTraces,
      withoutTraces,
      message: 'Recent successful executions have no recorded traces',
    };
  }

  return {
    status: 'ok',
    sampled,
    withTraces,
    withoutTraces,
    message: `${withTraces}/${sampled} recent successful execution(s) recorded traces`,
  };
}

function schedulerRunningMetric(metrics: unknown): boolean | null {
  const scheduler = objectRecord(objectRecord(metrics)?.scheduler);
  const running = scheduler?.running;
  return typeof running === 'boolean' ? running : null;
}

function countOnlineRecords(records: unknown[], fields: string[]): number {
  return records.filter((record) => {
    const object = objectRecord(record);
    return object ? fields.some((field) => object[field] === 'online') : false;
  }).length;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function nonNegativeIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellEnvReference(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid shell environment variable name: ${name}`);
  }
  return `"$${name}"`;
}

function doctorFailureMessage(stage: string, report: AgentHubDoctorReport): string {
  const errors = report.checks
    .filter((check) => check.status === 'error')
    .map((check) => `${check.name}: ${check.message ?? 'error'}`);
  return `Agent Hub canary ${stage} failed${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releaseCheckStepOk(result: unknown, fallback = true): boolean {
  const ok = objectRecord(result)?.ok;
  return typeof ok === "boolean" ? ok : fallback;
}

function runShellCommand(
  command: string,
  context: AgentHubRecoveryDrillCommandContext,
): Promise<AgentHubRecoveryDrillCommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, context.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        stage: context.stage,
        command,
        exitCode: 1,
        stdout,
        stderr: stderr ? `${stderr}\n${error.message}` : error.message,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        stage: context.stage,
        command,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

export class AgentHubControlClient {
  private config: Required<Pick<AgentHubControlConfig, 'serverUrl'>> & Omit<AgentHubControlConfig, 'serverUrl'>;

  constructor(config: AgentHubControlConfig) {
    this.config = {
      ...config,
      serverUrl: config.serverUrl.replace(/\/+$/, ''),
    };
  }

  async health(): Promise<unknown> {
    return this.requestJson('GET', '/api/health', undefined, 'none');
  }

  async ready(): Promise<unknown> {
    return this.requestJson('GET', '/api/ready', undefined, 'none');
  }

  async getMetrics(): Promise<AgentHubMetricsSnapshot> {
    return this.requestJson('GET', '/api/metrics', undefined, 'none');
  }

  async doctor(options: AgentHubDoctorOptions = {}): Promise<AgentHubDoctorReport> {
    const checks: AgentHubDoctorCheck[] = [];
    const report: AgentHubDoctorReport = {
      ok: true,
      generatedAt: new Date().toISOString(),
      serverUrl: this.config.serverUrl,
      summary: {
        errors: 0,
        warnings: 0,
      },
      checks,
    };

    report.health = await this.captureDoctorStep("health", checks, async () => {
      const health = await this.health();
      const status = recordStatus(health);
      if (status && status !== "ok") {
        return { value: health, check: { name: "health", status: "error", message: `Health status is ${status}` } };
      }
      return { value: health, check: { name: "health", status: "ok" } };
    });

    report.ready = await this.captureDoctorStep("ready", checks, async () => {
      const ready = await this.ready();
      const status = recordStatus(ready);
      if (status && status !== "ok") {
        return { value: ready, check: { name: "ready", status: "error", message: `Readiness status is ${status}` } };
      }
      return { value: ready, check: { name: "ready", status: "ok" } };
    });

    report.metrics = await this.captureDoctorStep("metrics", checks, async () => {
      const metrics = await this.getMetrics();
      const schedulerRunning = metrics.scheduler?.running;
      if (schedulerRunning === false) {
        return { value: metrics, check: { name: "scheduler", status: "warning", message: "Scheduler is not running" } };
      }
      return { value: metrics, check: { name: "scheduler", status: "ok" } };
    });

    report.projects = await this.captureDoctorStep("projects", checks, async () => {
      const projects = await this.listProjects() as AgentHubProjectRecord[];
      if (options.project) {
        const project = projects.find((candidate) => projectRecordMatches(candidate, options.project as string));
        if (!project) {
          report.project = {
            requested: options.project,
            found: false,
          };
          return {
            value: projects,
            check: { name: "project", status: "error", message: `Project ${options.project} not found` },
          };
        }
        report.project = {
          requested: options.project,
          found: true,
          id: project.id,
          name: project.name,
          displayName: project.displayName,
        };
        return {
          value: projects,
          check: { name: "project", status: "ok", message: `Project ${project.name} found` },
        };
      }
      return {
        value: projects,
        check: { name: "projects", status: "ok", message: `${projects.length} project(s)` },
      };
    });

    const projectId = report.project?.found ? report.project.id : undefined;
    if (!options.project || projectId) {
      report.agents = await this.captureDoctorStep("agents", checks, async () => {
        const agents = await this.listAgentsByProjectId(projectId ? { project: projectId } : {});
        return {
          value: agents,
          check: {
            name: "agents",
            status: agents.length > 0 ? "ok" : "warning",
            message: `${agents.length} agent(s) registered`,
          },
        };
      });

      report.executors = await this.captureDoctorStep("executors", checks, async () => {
        const executors = await this.listExecutorsByProjectId(projectId ? { project: projectId } : {});
        const agentCount = report.agents?.length ?? 0;
        return {
          value: executors,
          check: {
            name: "executors",
            status: agentCount > 0 && executors.length === 0 ? "warning" : "ok",
            message: `${executors.length} executor heartbeat(s) online`,
          },
        };
      });
    }

    report.alerts = await this.captureDoctorStep("alerts", checks, async () => {
      const alerts = await this.listAlerts({ limit: 20 });
      return {
        value: alerts,
        check: {
          name: "alerts",
          status: alerts.length > 0 ? "warning" : "ok",
          message: alerts.length > 0 ? `${alerts.length} active alert(s)` : "No active alerts",
        },
      };
    });

    report.summary = {
      errors: checks.filter((check) => check.status === "error").length,
      warnings: checks.filter((check) => check.status === "warning").length,
    };
    report.ok = report.summary.errors === 0;
    return report;
  }

  async getOpsStatus(options: AgentHubOpsStatusOptions = {}): Promise<AgentHubOpsStatusReport> {
    const doctor = await this.doctor(options.project ? { project: options.project } : {});
    const projectId = doctor.project?.found ? doctor.project.id : undefined;
    const projectQuery = projectId ? { project: projectId } : {};

    let scheduler: unknown;
    let agents: unknown[] = [];
    let executors: unknown[] = [];
    let executions: AgentHubOpsStatusReport["executions"] = {
      queued: [],
      running: [],
      success: [],
      failed: [],
      timeout: [],
    };
    if (!options.project || projectId) {
      scheduler = await this.requestJson(
        'GET',
        this.pathWithQuery('/api/scheduler/status', projectQuery),
        undefined,
        'dashboard',
      );
      agents = await this.listAgentsByProjectId(projectQuery);
      executors = await this.listExecutorsByProjectId(projectQuery);
      const executionLimit = positiveIntegerOr(options.executionLimit, 5);
      const [queued, running, success, failed, timeout] = await Promise.all([
        this.requestJson<unknown[]>('GET', this.pathWithQuery('/api/executions', {
          ...projectQuery,
          status: 'queued',
          limit: executionLimit,
        }), undefined, 'dashboard'),
        this.requestJson<unknown[]>('GET', this.pathWithQuery('/api/executions', {
          ...projectQuery,
          status: 'running',
          limit: executionLimit,
        }), undefined, 'dashboard'),
        this.requestJson<unknown[]>('GET', this.pathWithQuery('/api/executions', {
          ...projectQuery,
          status: 'success',
          limit: executionLimit,
        }), undefined, 'dashboard'),
        this.requestJson<unknown[]>('GET', this.pathWithQuery('/api/executions', {
          ...projectQuery,
          status: 'failed',
          limit: executionLimit,
        }), undefined, 'dashboard'),
        this.requestJson<unknown[]>('GET', this.pathWithQuery('/api/executions', {
          ...projectQuery,
          status: 'timeout',
          limit: executionLimit,
        }), undefined, 'dashboard'),
      ]);
      executions = {
        queued,
        running,
        success,
        failed,
        timeout,
      };
    }
    const alerts = await this.listAlerts({ limit: options.alertLimit ?? 20 });
    const metrics = doctor.metrics;
    const traceCoverage = summarizeTraceCoverage(executions.success);
    const traceCoverageWarnings = traceCoverage.status === 'warning' ? 1 : 0;
    const warningCount = doctor.summary.warnings + traceCoverageWarnings;

    const ok = doctor.ok && (options.failOnWarning === true ? warningCount === 0 : true);

    return {
      ok,
      generatedAt: new Date().toISOString(),
      serverUrl: this.config.serverUrl,
      project: doctor.project,
      summary: {
        errors: doctor.summary.errors,
        warnings: warningCount,
        schedulerRunning: schedulerRunningMetric(metrics),
        agentsTotal: agents.length,
        agentsOnline: countOnlineRecords(agents, ['executorStatus', 'executor_status', 'status']),
        executorsOnline: countOnlineRecords(executors, ['executorStatus', 'executor_status', 'status']),
        activeAlerts: alerts.length,
        executionsQueued: numberRecordField(metrics, 'executions_queued'),
        executionsRunning: numberRecordField(metrics, 'executions_running'),
        executionsFailed: numberRecordField(metrics, 'executions_failed'),
        executionsTimeout: numberRecordField(metrics, 'executions_timeout'),
      },
      doctor,
      metrics,
      scheduler,
      agents,
      executors,
      executions,
      traceCoverage,
      alerts,
    };
  }

  async observeOpsStatus(options: AgentHubObserveOpsStatusOptions = {}): Promise<AgentHubObserveOpsStatusReport> {
    const iterations = positiveIntegerOr(options.iterations, 24);
    const intervalMs = nonNegativeIntegerOr(options.intervalMs, 60 * 60 * 1000);
    const startedAt = new Date().toISOString();
    const snapshots: AgentHubOpsStatusReport[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      snapshots.push(await this.getOpsStatus({
        project: options.project,
        alertLimit: options.alertLimit,
        executionLimit: options.executionLimit,
        failOnWarning: options.failOnWarning,
      }));
      if (iteration < iterations - 1 && intervalMs > 0) {
        await delay(intervalMs);
      }
    }

    const failedIterations = snapshots.filter((snapshot) => !snapshot.ok).length;
    return {
      ok: failedIterations === 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      iterations,
      failedIterations,
      snapshots,
    };
  }

  getRecoveryPlan(options: AgentHubRecoveryPlanOptions = {}): AgentHubRecoveryPlan {
    const generatedAt = new Date().toISOString();
    const backupDir = options.backupDir ?? "/var/backups/agent-hub";
    const backupFile = options.backupFile ?? `${backupDir}/agent_hub_${generatedAt.replace(/[:.]/g, "-")}.sql`;
    const serviceName = options.serviceName ?? "agent-hub";
    const envFile = options.envFile ?? "/etc/agent-hub/agent-hub.env";
    const executionLimit = positiveIntegerOr(options.executionLimit, 5);
    const projectArgs = options.project ? ` --project ${shellQuote(options.project)}` : "";
    const loadEnvCommand = `set -a && . ${shellQuote(envFile)} && set +a`;
    const warnings = options.databaseUrlConfigured === true
      ? []
      : ["DATABASE_URL is not configured in this environment; load the production env file before running backup or restore commands."];

    return {
      generatedAt,
      serverUrl: this.config.serverUrl,
      project: options.project,
      databaseUrlConfigured: options.databaseUrlConfigured === true,
      backup: {
        outputPath: backupFile,
        commands: [
          `mkdir -p ${shellQuote(backupDir)}`,
          `${loadEnvCommand} && pg_dump "$DATABASE_URL" > ${shellQuote(backupFile)}`,
        ],
      },
      upgrade: {
        commands: [
          `sudo systemctl stop ${shellQuote(serviceName)}`,
          `${loadEnvCommand} && npm run db:migrate -w @agent-hub/server`,
          `sudo systemctl start ${shellQuote(serviceName)}`,
        ],
      },
      rollback: {
        commands: [
          `sudo systemctl stop ${shellQuote(serviceName)}`,
          `${loadEnvCommand} && psql "$DATABASE_URL" < ${shellQuote(backupFile)}`,
          `sudo systemctl start ${shellQuote(serviceName)}`,
        ],
      },
      verify: {
        commands: [
          `curl -fsS ${shellQuote(`${this.config.serverUrl}/api/ready`)}`,
          `node packages/sdk/dist/cli.js ops status${projectArgs} --strict --fail-on-warning --execution-limit ${executionLimit}`,
          `node packages/sdk/dist/cli.js ops observe${projectArgs} --iterations 2 --interval-ms 300000 --strict --fail-on-warning --execution-limit ${executionLimit}`,
        ],
      },
      warnings,
    };
  }

  getRecoveryDrillPlan(options: AgentHubRecoveryDrillPlanOptions = {}): AgentHubRecoveryDrillPlan {
    const generatedAt = new Date().toISOString();
    const backupDir = options.backupDir ?? "/var/backups/agent-hub";
    const backupFile = options.backupFile ?? `${backupDir}/agent_hub_rehearsal_${generatedAt.replace(/[:.]/g, "-")}.sql`;
    const envFile = options.envFile ?? "/etc/agent-hub/agent-hub.env";
    const executionLimit = positiveIntegerOr(options.executionLimit, 5);
    const restoreDatabaseEnvVar = options.restoreDatabaseEnvVar ?? "AGENT_HUB_RESTORE_DATABASE_URL";
    const restoreDatabaseRef = shellEnvReference(restoreDatabaseEnvVar);
    const projectArgs = options.project ? ` --project ${shellQuote(options.project)}` : "";
    const loadEnvCommand = `set -a && . ${shellQuote(envFile)} && set +a`;
    const warnings = [
      ...(options.databaseUrlConfigured === true
        ? []
        : ["DATABASE_URL is not configured in this environment; load the production env file before running backup commands."]),
      ...(options.restoreDatabaseUrlConfigured === true
        ? []
        : [`${restoreDatabaseEnvVar} is not configured in this environment; set it to a disposable restore database before running the drill.`]),
    ];

    return {
      generatedAt,
      serverUrl: this.config.serverUrl,
      project: options.project,
      databaseUrlConfigured: options.databaseUrlConfigured === true,
      restoreDatabaseUrlConfigured: options.restoreDatabaseUrlConfigured === true,
      restoreDatabaseEnvVar,
      preflight: {
        commands: [
          "command -v pg_dump",
          "command -v psql",
          `${loadEnvCommand} && test -n "$DATABASE_URL"`,
          `${loadEnvCommand} && test -n ${restoreDatabaseRef}`,
          `${loadEnvCommand} && test "$DATABASE_URL" != ${restoreDatabaseRef}`,
          `curl -fsS ${shellQuote(`${this.config.serverUrl}/api/ready`)}`,
          `node packages/sdk/dist/cli.js ops status${projectArgs} --strict --fail-on-warning --execution-limit ${executionLimit}`,
        ],
      },
      backup: {
        outputPath: backupFile,
        commands: [
          `mkdir -p ${shellQuote(backupDir)}`,
          `${loadEnvCommand} && pg_dump "$DATABASE_URL" > ${shellQuote(backupFile)}`,
        ],
      },
      restore: {
        commands: [
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'`,
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 < ${shellQuote(backupFile)}`,
          `${loadEnvCommand} && DATABASE_URL=${restoreDatabaseRef} npm run db:migrate -w @agent-hub/server`,
        ],
      },
      verify: {
        commands: [
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS projects FROM projects;'`,
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS agents FROM agents;'`,
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS executions FROM executions;'`,
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS traces FROM traces;'`,
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS executions_with_missing_agents FROM executions e LEFT JOIN agents a ON a.id = e.agent_id WHERE a.id IS NULL;'`,
          `${loadEnvCommand} && psql ${restoreDatabaseRef} -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS traces_with_missing_executions FROM traces t LEFT JOIN executions e ON e.id = t.execution_id WHERE e.id IS NULL;'`,
        ],
      },
      warnings,
    };
  }

  async runRecoveryDrill(options: AgentHubRunRecoveryDrillOptions = {}): Promise<AgentHubRunRecoveryDrillReport> {
    if (options.confirmRestoreDatabaseReset !== true) {
      throw new Error("Recovery drill execution requires confirmRestoreDatabaseReset=true. In the CLI, pass --yes-reset-restore-db after verifying AGENT_HUB_RESTORE_DATABASE_URL points at a disposable database.");
    }

    const startedAt = new Date().toISOString();
    const plan = this.getRecoveryDrillPlan(options);
    const timeoutMs = positiveIntegerOr(options.commandTimeoutMs, 10 * 60 * 1000);
    const commandRunner = options.commandRunner ?? runShellCommand;
    const commands: AgentHubRecoveryDrillCommandResult[] = [];
    const commandEntries: Array<{ stage: AgentHubRecoveryDrillStage; command: string }> = [
      ...plan.preflight.commands.map((command) => ({ stage: "preflight" as const, command })),
      ...plan.backup.commands.map((command) => ({ stage: "backup" as const, command })),
      ...plan.restore.commands.map((command) => ({ stage: "restore" as const, command })),
      ...plan.verify.commands.map((command) => ({ stage: "verify" as const, command })),
    ];

    for (const entry of commandEntries) {
      const result = await commandRunner(entry.command, {
        stage: entry.stage,
        timeoutMs,
      });
      commands.push(result);
      if (result.exitCode !== 0 || result.timedOut) {
        return {
          ok: false,
          startedAt,
          finishedAt: new Date().toISOString(),
          plan,
          commands,
          failedCommand: result,
        };
      }
    }

    return {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      plan,
      commands,
    };
  }

  async runReleaseCheck(options: AgentHubReleaseCheckOptions = {}): Promise<AgentHubReleaseCheckReport> {
    const startedAt = new Date().toISOString();
    const failOnWarning = options.failOnWarning ?? true;
    const steps: AgentHubReleaseCheckStep[] = [];

    const runStep = async (
      name: AgentHubReleaseCheckStep["name"],
      task: () => Promise<unknown>,
      okSelector: (result: unknown) => boolean = releaseCheckStepOk,
    ) => {
      try {
        const result = await task();
        const ok = okSelector(result);
        steps.push({ name, ok, skipped: false, result });
      } catch (error) {
        steps.push({ name, ok: false, skipped: false, error: errorMessage(error) });
      }
    };

    await runStep("doctor", async () => this.doctor(options.project ? { project: options.project } : {}), (result) => {
      const report = result as AgentHubDoctorReport;
      return report.ok && (failOnWarning ? report.summary.warnings === 0 : true);
    });

    await runStep("ops_status", async () => this.getOpsStatus({
      project: options.project,
      alertLimit: options.alertLimit,
      executionLimit: options.executionLimit,
      failOnWarning,
    }));

    if (options.includeRecoveryDrill === true) {
      await runStep("recovery_drill", async () => this.runRecoveryDrill(options));
    } else {
      steps.push({ name: "recovery_drill", ok: true, skipped: true });
    }

    if (options.canaryAgent) {
      await runStep("canary", async () => this.runCanary(options.canaryAgent as string, {
        project: options.project,
        payload: options.canaryPayload,
        timeoutMs: options.canaryTimeoutMs,
        intervalMs: options.canaryIntervalMs,
        dedupPolicy: "allow_duplicate",
        requireSuccess: true,
      }));
    } else {
      steps.push({ name: "canary", ok: true, skipped: true });
    }

    if (options.skipObserve === true) {
      steps.push({ name: "observe", ok: true, skipped: true });
    } else {
      await runStep("observe", async () => this.observeOpsStatus({
        project: options.project,
        alertLimit: options.alertLimit,
        executionLimit: options.executionLimit,
        failOnWarning,
        iterations: options.observeIterations ?? 2,
        intervalMs: options.observeIntervalMs ?? 5 * 60 * 1000,
      }));
    }

    return {
      ok: steps.every((step) => step.ok),
      startedAt,
      finishedAt: new Date().toISOString(),
      serverUrl: this.config.serverUrl,
      project: options.project,
      steps,
    };
  }

  async listProjects(): Promise<unknown[]> {
    return this.requestJson('GET', '/api/projects', undefined, 'dashboard');
  }

  async createProject(input: AgentHubCreateProjectInput): Promise<unknown> {
    return this.requestJson('POST', '/api/projects', input, 'dashboard');
  }

  async ensureProject(input: AgentHubCreateProjectInput): Promise<AgentHubEnsureProjectResult> {
    const projects = await this.listProjects() as AgentHubProjectRecord[];
    const existingProject = projects.find((project) => project.name === input.name);
    if (existingProject) {
      return {
        created: false,
        project: existingProject,
      };
    }

    return {
      created: true,
      ...(await this.createProject(input) as { project: AgentHubProjectRecord; api_key: string }),
    };
  }

  async rotateProjectApiKey(project: string): Promise<unknown> {
    const targetProject = await this.resolveProject(project);
    return this.requestJson(
      'POST',
      `/api/projects/${encodeURIComponent(targetProject.id)}/api-key`,
      undefined,
      'dashboard',
    );
  }

  async drainProject(
    project: string,
    options: AgentHubDrainProjectOptions = {},
  ): Promise<AgentHubDrainProjectResult> {
    const projects = await this.listProjects() as AgentHubProjectRecord[];
    const targetProject = projects.find((candidate) => projectRecordMatches(candidate, project));
    if (!targetProject) {
      throw new Error(`Agent Hub project ${project} not found`);
    }
    return this.requestJson('POST', `/api/projects/${encodeURIComponent(targetProject.id)}/drain`, {
      cancel_running: options.cancelRunning === true,
    }, 'dashboard');
  }

  async setProjectEnabled(project: string, enabled: boolean): Promise<AgentHubSetProjectEnabledResult> {
    const targetProject = await this.resolveProject(project);
    return this.requestJson('PATCH', '/api/agents/bulk', {
      project: targetProject.id,
      enabled,
    }, 'dashboard');
  }

  async listAgents(query: AgentHubListAgentsQuery = {}): Promise<unknown[]> {
    return this.listAgentsByProjectId(await this.resolveProjectQuery(query));
  }

  async getAgent(id: string, options: AgentHubGetAgentOptions = {}): Promise<unknown> {
    const agentId = await this.resolveAgentId(id, options);
    return this.requestJson(
      'GET',
      this.pathWithQuery(`/api/agents/${encodeURIComponent(agentId)}`, {
        include_archived: options.includeArchived === true ? true : undefined,
      }),
      undefined,
      'dashboard',
    );
  }

  async getSchedulerStatus(query: AgentHubSchedulerStatusQuery = {}): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.pathWithQuery('/api/scheduler/status', await this.resolveProjectQuery(query)),
      undefined,
      'dashboard',
    );
  }

  async listExecutors(query: AgentHubListExecutorsQuery = {}): Promise<unknown[]> {
    return this.listExecutorsByProjectId(await this.resolveProjectQuery(query));
  }

  async listAlerts(query: AgentHubListAlertsQuery = {}): Promise<unknown[]> {
    return this.requestJson(
      'GET',
      this.pathWithQuery('/api/alerts', {
        limit: query.limit,
        include_acknowledged: query.includeAcknowledged,
      }),
      undefined,
      'dashboard',
    );
  }

  async acknowledgeAlert(alertId: number, options: AgentHubAcknowledgeAlertOptions = {}): Promise<unknown> {
    return this.requestJson(
      'POST',
      `/api/alerts/${encodeURIComponent(String(alertId))}/acknowledge`,
      {
        acknowledgedBy: options.acknowledgedBy,
      },
      'dashboard',
    );
  }

  async createAgent(input: AgentHubCreateAgentInput): Promise<unknown> {
    const { project, ...body } = input;
    const projectId = body.projectId ?? (project ? (await this.resolveProject(project)).id : undefined);
    return this.requestJson('POST', '/api/agents', {
      ...body,
      projectId,
    }, 'dashboard');
  }

  async updateAgent(
    agentId: string,
    patch: AgentHubUpdateAgentInput,
    options: AgentHubAgentTargetOptions = {},
  ): Promise<unknown> {
    const resolvedAgentId = await this.resolveAgentId(agentId, options);
    return this.requestJson('PATCH', `/api/agents/${encodeURIComponent(resolvedAgentId)}`, patch, 'dashboard');
  }

  async deleteAgent(agentId: string, options: AgentHubAgentTargetOptions = {}): Promise<void> {
    const resolvedAgentId = await this.resolveAgentId(agentId, options);
    await this.requestJson('DELETE', `/api/agents/${encodeURIComponent(resolvedAgentId)}`, undefined, 'dashboard');
  }

  async drainAgent(
    agentId: string,
    options: AgentHubDrainAgentOptions = {},
  ): Promise<AgentHubDrainAgentResult> {
    const resolvedAgentId = await this.resolveAgentId(agentId, options);
    return this.requestJson('POST', `/api/agents/${encodeURIComponent(resolvedAgentId)}/drain`, {
      cancel_running: options.cancelRunning === true,
    }, 'dashboard');
  }

  async getAgentSchedulePreview(agentId: string, options: AgentHubSchedulePreviewOptions = {}): Promise<unknown> {
    const resolvedAgentId = await this.resolveAgentId(agentId, options);
    return this.requestJson(
      'GET',
      this.pathWithQuery(`/api/agents/${encodeURIComponent(resolvedAgentId)}/schedule-preview`, {
        limit: options.limit,
      }),
      undefined,
      'dashboard',
    );
  }

  async setAgentEnabled(
    agentId: string,
    enabled: boolean,
    options: AgentHubAgentTargetOptions = {},
  ): Promise<unknown> {
    return this.updateAgent(agentId, { enabled }, options);
  }

  async listExecutions(query: AgentHubListExecutionsQuery = {}): Promise<unknown[]> {
    return this.requestJson(
      'GET',
      this.pathWithQuery('/api/executions', await this.resolveExecutionQuery(query)),
      undefined,
      'dashboard',
    );
  }

  async getExecution(id: string): Promise<unknown> {
    return this.requestJson('GET', `/api/executions/${encodeURIComponent(id)}`, undefined, 'dashboard');
  }

  async inspectExecution(executionId: string): Promise<AgentHubInspectExecutionResult> {
    const execution = await this.getExecution(executionId);
    const traces = await this.getExecutionTraces(executionId);
    const triggerChain = await this.getExecutionTriggerChain(executionId);
    return {
      execution,
      traces,
      triggerChain,
    };
  }

  async waitForExecution(
    executionId: string,
    options: AgentHubWaitExecutionOptions = {},
  ): Promise<unknown> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 10 * 60 * 1000);
    const intervalMs = Math.max(0, options.intervalMs ?? 1000);
    const startedAt = Date.now();

    while (true) {
      const execution = await this.getExecution(executionId);
      const status = executionStatus(execution);
      if (status && terminalExecutionStatuses.has(status)) {
        if (options.requireSuccess === true && status !== 'success') {
          throw new Error(`Agent Hub execution ${executionId} finished with terminal status ${status}`);
        }
        return execution;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Agent Hub execution ${executionId} wait timed out after ${timeoutMs}ms`);
      }

      await sleep(intervalMs);
    }
  }

  async getExecutionTraces(executionId: string): Promise<unknown[]> {
    return this.requestJson('GET', `/api/executions/${encodeURIComponent(executionId)}/traces`, undefined, 'dashboard');
  }

  async getExecutionTriggerChain(executionId: string): Promise<unknown[]> {
    return this.requestJson('GET', `/api/executions/${encodeURIComponent(executionId)}/trigger-chain`, undefined, 'dashboard');
  }

  async triggerAgent(agentName: string, options: AgentHubTriggerOptions = {}): Promise<AgentHubTriggerResult> {
    return this.requestJson<AgentHubTriggerResult>(
      'POST',
      `/api/agents/${encodeURIComponent(agentName)}/trigger`,
      {
        payload: options.payload ?? {},
        idempotency_key: options.idempotencyKey,
        dedup_policy: options.dedupPolicy ?? 'skip_if_running',
      },
      'apiKey',
      { 'X-Trigger-Source': 'cli' },
    );
  }

  async triggerAgentAndWait(
    agentName: string,
    triggerOptions: AgentHubTriggerOptions = {},
    waitOptions: AgentHubWaitExecutionOptions = {},
  ): Promise<AgentHubTriggerAndWaitResult> {
    const trigger = await this.triggerAgent(agentName, triggerOptions);
    const executionId = triggerExecutionId(trigger);
    if (!executionId) {
      throw new Error(`Agent Hub trigger response for ${agentName} did not include execution_id`);
    }
    return {
      trigger,
      execution: await this.waitForExecution(executionId, waitOptions),
    };
  }

  async runCanary(
    agentName: string,
    options: AgentHubRunCanaryOptions = {},
  ): Promise<AgentHubRunCanaryResult> {
    const doctorOptions = options.project ? { project: options.project } : {};
    const preflight = await this.doctor(doctorOptions);
    if (!preflight.ok) {
      throw new Error(doctorFailureMessage('preflight', preflight));
    }

    const run = await this.triggerAgentAndWait(agentName, {
      payload: options.payload,
      idempotencyKey: options.idempotencyKey,
      dedupPolicy: options.dedupPolicy ?? 'allow_duplicate',
    }, {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
      requireSuccess: options.requireSuccess ?? true,
    });

    const postflight = await this.doctor(doctorOptions);
    if (!postflight.ok) {
      throw new Error(doctorFailureMessage('postflight', postflight));
    }

    return {
      preflight,
      trigger: run.trigger,
      execution: run.execution,
      postflight,
    };
  }

  async cancelExecution(executionId: string): Promise<unknown> {
    return this.requestJson('POST', `/api/executions/${encodeURIComponent(executionId)}/cancel`, undefined, 'dashboard');
  }

  async rerunExecution(executionId: string): Promise<unknown> {
    return this.requestJson('POST', `/api/executions/${encodeURIComponent(executionId)}/rerun`, undefined, 'dashboard');
  }

  private async resolveProject(project: string): Promise<AgentHubProjectRecord> {
    const projects = await this.listProjects() as AgentHubProjectRecord[];
    const targetProject = projects.find((candidate) => projectRecordMatches(candidate, project));
    if (!targetProject) {
      throw new Error(`Agent Hub project ${project} not found`);
    }
    return targetProject;
  }

  private async resolveProjectQuery<T extends { project?: string }>(query: T): Promise<T> {
    if (!query.project) return query;
    return {
      ...query,
      project: (await this.resolveProject(query.project)).id,
    };
  }

  private async resolveExecutionQuery(query: AgentHubListExecutionsQuery): Promise<Record<string, QueryValue>> {
    const projectId = query.project ? (await this.resolveProject(query.project)).id : undefined;
    const agentId = query.agent
      ? await this.resolveAgentIdFromProjectAgentList(query.agent, projectId, query.project)
      : query.agent_id;

    return {
      project: agentId ? undefined : projectId,
      agent_id: agentId,
      status: query.status,
      trigger_type: query.trigger_type,
      since: query.since,
      limit: query.limit,
      offset: query.offset,
    };
  }

  private async resolveAgentIdFromProjectAgentList(
    agent: string,
    projectId: string | undefined,
    projectLabel: string | undefined,
  ): Promise<string> {
    if (!projectId && looksLikeDirectAgentId(agent)) {
      return agent;
    }

    const agents = await this.listAgentsByProjectId({
      project: projectId,
      archived: 'include',
    }) as AgentHubAgentRecord[];
    const matches = agents.filter((candidate) => candidate.id === agent || candidate.name === agent);

    if (matches.length === 1) {
      return matches[0].id;
    }
    if (matches.length === 0) {
      const projectSuffix = projectLabel ? ` in project ${projectLabel}` : '';
      throw new Error(`Agent Hub agent ${agent} not found${projectSuffix}`);
    }
    throw new Error(`Agent Hub agent ${agent} is ambiguous; pass --project`);
  }

  private async listAgentsByProjectId(query: AgentHubListAgentsQuery = {}): Promise<unknown[]> {
    return this.requestJson('GET', this.pathWithQuery('/api/agents', query), undefined, 'dashboard');
  }

  private async listExecutorsByProjectId(query: AgentHubListExecutorsQuery = {}): Promise<unknown[]> {
    return this.requestJson('GET', this.pathWithQuery('/api/executors', query), undefined, 'dashboard');
  }

  private async resolveAgentId(
    agent: string,
    options: AgentHubAgentTargetOptions & { includeArchived?: boolean } = {},
  ): Promise<string> {
    if (!options.project && looksLikeDirectAgentId(agent)) {
      return agent;
    }

    const projectId = options.project ? (await this.resolveProject(options.project)).id : undefined;
    const agents = await this.listAgentsByProjectId({
      project: projectId,
      archived: options.includeArchived === true ? 'include' : undefined,
    }) as AgentHubAgentRecord[];
    const matches = agents.filter((candidate) => candidate.id === agent || candidate.name === agent);

    if (matches.length === 1) {
      return matches[0].id;
    }
    if (matches.length === 0) {
      const projectSuffix = options.project ? ` in project ${options.project}` : '';
      throw new Error(`Agent Hub agent ${agent} not found${projectSuffix}`);
    }
    throw new Error(`Agent Hub agent ${agent} is ambiguous; pass --project`);
  }

  private pathWithQuery(path: string, query: object): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query) as Array<[string, QueryValue]>) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const search = params.toString();
    return search ? `${path}?${search}` : path;
  }

  private async captureDoctorStep<T>(
    name: string,
    checks: AgentHubDoctorCheck[],
    action: () => Promise<{ value: T; check: AgentHubDoctorCheck }>,
  ): Promise<T | undefined> {
    try {
      const { value, check } = await action();
      checks.push(check);
      return value;
    } catch (error) {
      checks.push({
        name,
        status: "error",
        message: errorMessage(error),
      });
      return undefined;
    }
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    auth: AuthMode = 'dashboard',
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Agent-Hub-Version': '1',
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (auth === 'dashboard') {
      headers.Authorization = this.dashboardAuthorization();
    } else if (auth === 'apiKey') {
      headers.Authorization = `Bearer ${this.apiKey()}`;
    }

    const response = await fetch(`${this.config.serverUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await this.errorMessage(response);
      throw new Error(`Agent Hub ${method} ${path} failed with HTTP ${response.status}: ${message}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return response.json() as Promise<T>;
  }

  private dashboardAuthorization(): string {
    const username = this.config.dashboardUsername ?? 'admin';
    const password = this.config.dashboardPassword ?? 'admin';
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  private apiKey(): string {
    const apiKey = this.config.apiKey ?? 'agent_hub_dev_key';
    if (!apiKey) {
      throw new Error('Agent Hub API key is required for write operations');
    }
    return apiKey;
  }

  private async errorMessage(response: Response): Promise<string> {
    const text = await response.text();
    if (!text) return response.statusText || 'request failed';
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const message = parsed.error ?? parsed.message;
      return typeof message === 'string' ? message : text;
    } catch {
      return text;
    }
  }
}

export type HandlerFn = (ctx: ExecutionContext) => Promise<Record<string, unknown>>;

class AgentHubExecutionCancelledError extends Error {
  constructor(executionId: string) {
    super(`Agent Hub execution ${executionId} was cancelled`);
    this.name = 'AgentHubExecutionCancelledError';
  }
}

export class AgentHubClient {
  private config: AgentHubConfig;
  private handlers = new Map<string, HandlerFn>();
  private agents: AgentSpec[] = [];
  private traceBuffer: TraceSpan[] = [];
  private currentExecutionId: string | null = null;
  private currentExecutionAbortController: AbortController | null = null;
  private currentExecutionCancelled = false;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AgentHubConfig) {
    this.config = config;
    if (!config.serverUrls) {
      config.serverUrls = [config.serverUrl];
    }
  }

  register(spec: AgentSpec) {
    this.agents.push(spec);
  }

  handle(name: string, fn: HandlerFn) {
    this.handlers.set(name, fn);
  }

  async start() {
    this.running = true;
    try {
      await this.syncRegistry();
      this.startHeartbeat();
      while (this.running) {
        try {
          await this.runOnce();
        } catch (err) {
          // Network error — back off and retry
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  async syncRegistry(): Promise<unknown[]> {
    this.validateRegisteredHandlers();
    const registered = [];
    for (const agent of this.agents) {
      const res = await this.fetch('PUT', `/api/registry/agents`, agent);
      if (!res.ok) {
        throw new Error(`Failed to register ${agent.name}: HTTP ${res.status}`);
      }
      registered.push(await res.json());
    }
    return registered;
  }

  stop() {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async runOnce(): Promise<boolean> {
    const names = this.agents.map((agent) => agent.name).join(',');
    if (!names) return false;

    const res = await this.fetch('GET', `/api/executors/poll?agent_names=${encodeURIComponent(names)}`);
    if (res.status === 204) return false;
    if (!res.ok) {
      throw new Error(`Agent Hub poll failed with HTTP ${res.status}`);
    }

    const exec: Execution = await res.json();
    await this.execute(exec);
    return true;
  }

  private pickUrl(): string {
    const urls = this.config.serverUrls!;
    return urls[Math.floor(Math.random() * urls.length)];
  }

  private validateRegisteredHandlers() {
    for (const agent of this.agents) {
      const handlerName = agent.handler || agent.name;
      if (!this.handlers.has(handlerName) && !this.handlers.has(agent.name)) {
        throw new Error(`Agent Hub handler ${handlerName} is not registered for agent ${agent.name}`);
      }
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer !== null) return;
    const heartbeat = async () => {
      try {
        const body: {
          agent_names: string[];
          executions?: Array<{ execution_id: string }>;
        } = {
          agent_names: this.agents.map((agent) => agent.name),
        };
        if (this.currentExecutionId) {
          body.executions = [{ execution_id: this.currentExecutionId }];
        }
        const response = await this.fetch('POST', '/api/executors/heartbeat', body);
        await this.handleHeartbeatResponse(response);
      } catch {} // silently skip on network error
    };
    void heartbeat();
    this.heartbeatTimer = setInterval(heartbeat, 10_000);
  }

  async reportProgress(executionId: string, percent: number, message?: string) {
    const progressPercent = Math.max(0, Math.min(100, Math.trunc(percent)));
    const executionProgress: {
      execution_id: string;
      progress_percent: number;
      progress_message?: string;
    } = {
      execution_id: executionId,
      progress_percent: progressPercent,
    };
    if (message !== undefined) {
      executionProgress.progress_message = message;
    }

    const res = await this.fetch('POST', '/api/executors/heartbeat', {
      agent_names: this.agents.map((agent) => agent.name),
      executions: [executionProgress],
    });
    if (!res.ok) {
      throw new Error(`Agent Hub progress failed with HTTP ${res.status}`);
    }
    await this.handleHeartbeatResponse(res);
    this.throwIfExecutionCancelled(executionId);
  }

  recordTrace(span: Omit<TraceSpan, 'turn_index' | 'span_index'> & { turn_index?: number; span_index?: number }) {
    this.traceBuffer.push({
      ...span,
      turn_index: span.turn_index ?? 0,
      span_index: span.span_index ?? this.traceBuffer.length,
    });
  }

  private async execute(exec: Execution) {
    this.currentExecutionId = exec.id;
    this.currentExecutionCancelled = false;
    const abortController = new AbortController();
    this.currentExecutionAbortController = abortController;
    this.traceBuffer = [];
    const timeoutMs = Math.max(1, exec.timeoutSeconds ?? 600) * 1000;
    const timeoutTimer = setTimeout(() => {
      if (!abortController.signal.aborted) {
        abortController.abort(new Error('Agent Hub execution timed out'));
      }
    }, timeoutMs);

    try {
      const agent = this.agents.find(a =>
        a.name === exec.agentName ||
        a.handler === exec.handlerName
      );
      const handler = agent
        ? this.handlers.get(agent.handler) ?? this.handlers.get(agent.name)
        : undefined;

      let result: {
        status: string;
        result_summary?: string;
        result_data?: unknown;
        error_message?: string;
        error_stack?: string;
        trace_count_expected?: number;
      };

      if (handler) {
        try {
          const ctx = new ExecutionContext(this, exec, abortController.signal);
          const data = await handler(ctx);
          if (this.currentExecutionCancelled) {
            await this.flushTraces();
            return;
          }
          result = { status: 'success', result_data: data, trace_count_expected: this.traceBuffer.length };
        } catch (err: any) {
          if (this.currentExecutionCancelled) {
            await this.flushTraces();
            return;
          }
          result = { status: 'failed', error_message: err.message, error_stack: err.stack, trace_count_expected: this.traceBuffer.length };
        }
      } else {
        result = { status: 'failed', error_message: `No handler for agent`, trace_count_expected: 0 };
      }

      if (this.currentExecutionCancelled) {
        await this.flushTraces();
        return;
      }
      await this.flushTraces();
      const report = await this.fetch('POST', `/api/executions/${exec.id}/report`, result);
      if (!report.ok) {
        throw new Error(`Agent Hub report failed with HTTP ${report.status}`);
      }
    } finally {
      clearTimeout(timeoutTimer);
      this.currentExecutionId = null;
      this.currentExecutionAbortController = null;
      this.currentExecutionCancelled = false;
    }
  }

  private async handleHeartbeatResponse(response: Response) {
    if (!response.ok || response.status === 204) return;
    const body = await response.clone().json().catch(() => null) as HeartbeatResponse | null;
    for (const executionId of body?.cancelled_execution_ids ?? []) {
      this.markExecutionCancelled(executionId);
    }
  }

  private markExecutionCancelled(executionId: string) {
    if (this.currentExecutionId !== executionId) return;
    this.currentExecutionCancelled = true;
    if (!this.currentExecutionAbortController?.signal.aborted) {
      this.currentExecutionAbortController?.abort(new AgentHubExecutionCancelledError(executionId));
    }
  }

  private throwIfExecutionCancelled(executionId: string) {
    if (this.currentExecutionId !== executionId || !this.currentExecutionCancelled) return;
    const reason = this.currentExecutionAbortController?.signal.reason;
    if (reason instanceof Error) throw reason;
    throw new AgentHubExecutionCancelledError(executionId);
  }

  async fetch(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    const url = this.pickUrl() + path;
    const opts: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Agent-Hub-Version': '1',
        ...extraHeaders,
      },
    };
    if (this.config.apiKey) {
      (opts.headers as Record<string, string>)['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts);
  }

  async flushTraces() {
    if (this.traceBuffer.length === 0 || !this.currentExecutionId) return;
    const traces = [...this.traceBuffer];
    this.traceBuffer = [];
    await this.fetch('POST', `/api/executions/${this.currentExecutionId}/traces`, { traces });
  }
}

export class ExecutionContext {
  private client: AgentHubClient;
  private exec: Execution;
  signal: AbortSignal;

  constructor(client: AgentHubClient, exec: Execution, signal: AbortSignal) {
    this.client = client;
    this.exec = exec;
    this.signal = signal;
  }

  get payload(): Record<string, unknown> {
    return this.exec.inputPayload ?? {};
  }

  async log(message: string) {
    console.log(`[${this.exec.id}] ${message}`);
    this.client.recordTrace({
      role: 'tool',
      span_type: 'log',
      output_content: message,
    });
  }

  async progress(percent: number, message?: string) {
    await this.client.reportProgress(this.exec.id, percent, message);
  }

  async trigger(agentName: string, opts: {
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
    dedupPolicy?: 'skip_if_running' | 'skip_if_exists' | 'allow_duplicate';
  }) {
    const res = await this.client.fetch(
      'POST',
      `/api/agents/${agentName}/trigger`,
      {
        payload: opts.payload ?? {},
        idempotency_key: opts.idempotencyKey,
        dedup_policy: opts.dedupPolicy ?? 'skip_if_running',
      },
      { 'X-Execution-ID': this.exec.id },
    );
    return res.json();
  }

  async triggerBatch(requests: Array<{ agent: string; payload?: Record<string, unknown>; idempotencyKey?: string }>, opts?: { concurrency?: number }) {
    const limit = opts?.concurrency ?? 5;
    const results = [];
    for (let i = 0; i < requests.length; i += limit) {
      const batch = requests.slice(i, i + limit);
      results.push(...await Promise.all(batch.map(r => this.trigger(r.agent, { payload: r.payload, idempotencyKey: r.idempotencyKey }))));
    }
    return results;
  }

  llm = {
    chat: async (req: { model: string; messages: Array<{ role: string; content: string }>; signal?: AbortSignal }) => {
      const start = Date.now();
      // Make the actual LLM call (OpenAI-compatible)
      const response = await fetch(process.env.LLM_API_URL ?? 'http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages }),
        signal: req.signal ?? this.signal,
      });
      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content ?? '';

      // Auto-trace
      const span: TraceSpan = {
        turn_index: 0,
        role: 'assistant',
        span_type: 'llm',
        model: req.model,
        input_content: JSON.stringify(req.messages),
        output_content: content,
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
        latency_ms: Date.now() - start,
      };
      this.client.recordTrace(span);

      return { content };
    },
  };

  trace = {
    startSpan: (name: string) => {
      const startedAt = Date.now();
      let output: unknown;
      let ended = false;
      const finish = (status: 'success' | 'error', error?: Error) => {
        if (ended) return;
        ended = true;
        const span: Omit<TraceSpan, 'turn_index' | 'span_index'> = {
          role: 'tool',
          span_type: status === 'error' ? 'error' : 'custom',
          input_content: name,
          latency_ms: Date.now() - startedAt,
          metadata: {
            name,
            status,
          },
        };
        if (error) {
          span.output_content = error.message;
          span.metadata = {
            ...span.metadata,
            error_message: error.message,
            error_stack: error.stack,
          };
        } else if (output !== undefined) {
          span.output_content = this.serializeTraceContent(output);
        }
        this.client.recordTrace(span);
      };

      return {
        setOutput: (data: unknown) => {
          output = data;
        },
        end: () => finish('success'),
        error: (err: Error) => finish('error', err),
      };
    },
  };

  private serializeTraceContent(data: unknown): string {
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }

  cooldowns = {
    get: async (key: string) => {
      const res = await (this.client as any).fetch('GET', `/api/cooldowns/${this.exec.agentName ?? this.exec.agentId}/${key}`);
      return res.json();
    },
    set: async (key: string) => {
      await (this.client as any).fetch('PUT', `/api/cooldowns/${this.exec.agentName ?? this.exec.agentId}/${key}`, { last_run_at: new Date().toISOString() });
    },
  };
}
