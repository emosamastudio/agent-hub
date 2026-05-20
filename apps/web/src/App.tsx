import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import {
  acknowledgeAlert,
  cancelExecution,
  createAgent,
  deleteAgent,
  drainAgent,
  fetchAlerts,
  fetchAgentDetail,
  fetchAgents,
  fetchExecutionDetail,
  fetchExecutions,
  fetchProjects,
  fetchSchedulePreview,
  fetchSchedulerStatus,
  fetchStats,
  fetchTriggerChain,
  fetchTraces,
  patchAgent,
  rerunExecution,
  triggerAgent,
  connectSocket,
} from "./lib/api";
import {
  DEFAULT_EXECUTION_PAGE_SIZE,
  agentSettingsPatchFromForm,
  executionDisplayTime,
  executionQueryParamsFromFilters,
  parseTriggerPayload,
  type AgentSettingsFormValues,
  type ExecutionFilterValues,
  type ExecutionQueryOptions,
} from "./lib/dashboard-helpers";
import "./App.css";

/* ── Types ─────────────────────────────────────────────────────── */

type SocketStatus = "connecting" | "open" | "reconnecting" | "error";
type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";
type Page = "overview" | "agents" | "executions" | "detail" | "agent-detail";
type MisfirePolicy = "fire_once" | "fire_all" | "drop";

interface PageDefinition {
  id: Page;
  label: string;
  description: string;
  badge?: string;
}

interface Project {
  id: string;
  name: string;
  displayName: string;
  status?: string;
}

interface Agent {
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
}

interface SchedulerAgentStatus {
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
}

interface SchedulerStatusSnapshot {
  generatedAt: string;
  scheduler: {
    tickMs: number;
    executionRetentionDays: number;
    traceRetentionDays: number;
  };
  agents: SchedulerAgentStatus[];
}

interface Execution {
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
}

interface DashboardStats {
  agents_total?: number;
  agentsTotal?: number;
  agents_online?: number;
  agentsOnline?: number;
  recent_failures?: number;
  recentFailures?: number;
  recent_success_rate?: string;
  recentSuccessRate?: string;
}

interface AlertEntry {
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
}

interface TraceSpan {
  turnIndex?: number;
  turn_index?: number;
  spanIndex?: number;
  span_index?: number;
  role?: string;
  spanType?: string;
  span_type?: string;
  model?: string | null;
  latencyMs?: number | null;
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
}

interface TriggerChainEntry {
  id: string;
  agentId?: string;
  agent_id?: string;
  triggerType?: string;
  trigger_type?: string;
  triggeredBy?: string | null;
  triggered_by?: string | null;
  parentExecutionId?: string | null;
  parent_execution_id?: string | null;
  triggerDepth?: number;
  trigger_depth?: number;
  status?: string;
  scheduledAt?: string | null;
  scheduled_at?: string | null;
  startedAt?: string | null;
  started_at?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
}

interface AgentCreateFormValues {
  projectId: string;
  name: string;
  displayName: string;
  agentType: "cron_task" | "llm_agent";
  cronExpression: string;
  handlerName: string;
  concurrency: string;
  timeoutSeconds: string;
  retryMax: string;
  maxPendingQueue: string;
}

interface ExecutionLoadOptions extends ExecutionQueryOptions {
  append?: boolean;
}

const EXECUTION_PAGE_SIZE = DEFAULT_EXECUTION_PAGE_SIZE;
const DEFAULT_TRIGGER_PAYLOAD_TEXT = '{\n  "source": "dashboard"\n}';

/* ── Helpers ──────────────────────────────────────────────────── */

function getSocketTone(status: SocketStatus): StatusTone {
  switch (status) {
    case "open":
      return "success";
    case "connecting":
      return "info";
    case "reconnecting":
      return "warning";
    default:
      return "danger";
  }
}

function getStatusTone(status: string): StatusTone {
  switch (status) {
    case "success":
      return "success";
    case "failed":
    case "timeout":
    case "error":
      return "danger";
    case "running":
      return "info";
    case "queued":
    case "pending":
      return "warning";
    default:
      return "neutral";
  }
}

function getAlertTone(severity: string): StatusTone {
  switch (severity) {
    case "critical":
    case "error":
      return "danger";
    case "warning":
      return "warning";
    case "info":
      return "info";
    default:
      return "neutral";
  }
}

function isTerminalExecution(status: string): boolean {
  return ["success", "failed", "timeout", "cancelled"].includes(status);
}

function canCancelExecution(execution: Execution): boolean {
  return ["queued", "running"].includes(execution.status);
}

function socketStatusLabel(status: SocketStatus): string {
  switch (status) {
    case "open":
      return "WebSocket live";
    case "connecting":
      return "WebSocket connecting";
    case "reconnecting":
      return "WebSocket reconnecting";
    default:
      return "WebSocket error";
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "-";
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes.toFixed(0) : minutes.toFixed(1)}m`;
}

function agentDisplayName(a: Agent): string {
  return a.displayName || a.name || (a.id ? a.id.slice(0, 8) : "?");
}

function alertDisplayName(alert: AlertEntry): string {
  return alert.agentDisplayName || alert.agentName || "Agent Hub";
}

function formatAlertRule(ruleName: string): string {
  return ruleName.replaceAll("_", " ");
}

function alertTimestamp(alert: AlertEntry): number {
  if (!alert.createdAt) return 0;
  const value = new Date(alert.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function visibleAlerts(alerts: AlertEntry[]): AlertEntry[] {
  const byRuleAndAgent = new Map<string, AlertEntry>();
  for (const alert of alerts) {
    const key = `${alert.ruleName}:${alert.agentId ?? "hub"}`;
    const existing = byRuleAndAgent.get(key);
    if (!existing || alertTimestamp(alert) > alertTimestamp(existing)) {
      byRuleAndAgent.set(key, alert);
    }
  }
  return Array.from(byRuleAndAgent.values())
    .sort((left, right) => alertTimestamp(right) - alertTimestamp(left));
}

function projectName(a: Agent): string {
  return (a.name || "").split("_")[0] || "-";
}

function projectDisplayName(projects: Project[], projectId: string): string {
  const project = projects.find((item) => item.id === projectId);
  return project?.displayName || project?.name || projectId.slice(0, 8) || "-";
}

function agentStatusTone(agent: Agent): StatusTone {
  if (agent.archivedAt) return "neutral";
  if (!agent.enabled) return "neutral";
  return agent.executorStatus === "online" ? "success" : "warning";
}

function agentStatusLabel(agent: Agent): string {
  if (agent.archivedAt) return "archived";
  if (!agent.enabled) return "disabled";
  return agent.executorStatus === "online" ? "online" : "offline";
}

function schedulerStateTone(state: string | null | undefined): StatusTone {
  switch (state) {
    case "dispatchable":
    case "scheduled":
      return "success";
    case "due":
    case "queue_full":
    case "concurrency_full":
    case "executor_offline":
      return "warning";
    case "invalid_cron":
      return "danger";
    case "archived":
    case "disabled":
    case "idle":
    case "manual_only":
      return "neutral";
    default:
      return "neutral";
  }
}

function schedulerStatusByAgentId(
  schedulerStatus: SchedulerStatusSnapshot | null | undefined,
): Map<string, SchedulerAgentStatus> {
  const byId = new Map<string, SchedulerAgentStatus>();
  for (const agentStatus of schedulerStatus?.agents ?? []) {
    byId.set(agentStatus.id, agentStatus);
  }
  return byId;
}

function formatSchedulerQueue(status: SchedulerAgentStatus | undefined): string {
  if (!status) return "-";
  const pending = status.pendingCount ?? status.queuedCount ?? 0;
  if (status.maxPendingQueue == null) return `${pending} pending`;
  return `${pending} / ${status.maxPendingQueue} pending`;
}

function formatSchedulerCapacity(status: SchedulerAgentStatus | undefined): string {
  if (!status) return "-";
  return `${status.capacityAvailable ?? 0} / ${status.concurrency ?? 0} free`;
}

function triggerChainAgentId(entry: TriggerChainEntry): string {
  return entry.agentId ?? entry.agent_id ?? "";
}

function triggerChainTriggerType(entry: TriggerChainEntry): string {
  return entry.triggerType ?? entry.trigger_type ?? "-";
}

function triggerChainTriggeredBy(entry: TriggerChainEntry): string {
  return entry.triggeredBy ?? entry.triggered_by ?? "-";
}

function triggerChainDepth(entry: TriggerChainEntry): number {
  return entry.triggerDepth ?? entry.trigger_depth ?? 0;
}

function triggerChainTime(entry: TriggerChainEntry): string | null {
  return entry.startedAt ?? entry.started_at ?? entry.scheduledAt ?? entry.scheduled_at ?? entry.createdAt ?? entry.created_at ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to load data";
}

function initialAgentCreateForm(projectId = ""): AgentCreateFormValues {
  return {
    projectId,
    name: "",
    displayName: "",
    agentType: "cron_task",
    cronExpression: "",
    handlerName: "",
    concurrency: "1",
    timeoutSeconds: "600",
    retryMax: "3",
    maxPendingQueue: "100",
  };
}

function parseIntegerWithMin(value: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function agentSettingsFormFromAgent(agent: Agent): AgentSettingsFormValues {
  return {
    displayName: agent.displayName || agent.name,
    cronExpression: agent.cronExpression ?? "",
    handlerName: agent.handlerName ?? "",
    misfirePolicy: agent.misfirePolicy ?? "fire_once",
    concurrency: String(agent.concurrency ?? 1),
    maxPendingQueue: String(agent.maxPendingQueue ?? 100),
    timeoutSeconds: String(agent.timeoutSeconds ?? 600),
    retryMax: String(agent.retryMax ?? 3),
    retryBackoffBaseMs: String(agent.retryBackoffBaseMs ?? 30000),
    idempotencyWindowSeconds: String(agent.idempotencyWindowSeconds ?? 3600),
  };
}

function initialAgentSettingsForm(): AgentSettingsFormValues {
  return {
    displayName: "",
    cronExpression: "",
    handlerName: "",
    misfirePolicy: "fire_once",
    concurrency: "1",
    maxPendingQueue: "100",
    timeoutSeconds: "600",
    retryMax: "3",
    retryBackoffBaseMs: "30000",
    idempotencyWindowSeconds: "3600",
  };
}

function initialExecutionFilters(): ExecutionFilterValues {
  return {
    agentId: "",
    status: "",
    triggerType: "",
  };
}

function hasExecutionFilters(values: ExecutionFilterValues): boolean {
  return Boolean(values.agentId || values.status || values.triggerType);
}

/* ── Sub-components ───────────────────────────────────────────── */

type IconName =
  | "arrow-left"
  | "cancel"
  | "cube"
  | "execution"
  | "external"
  | "layout"
  | "play"
  | "plus"
  | "pulse"
  | "refresh"
  | "signal"
  | "team"
  | "timer"
  | "tray";

function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const common = {
    className: `ui-icon ${className}`.trim(),
    viewBox: "0 0 24 24",
    fill: "none",
    "aria-hidden": true,
  };

  switch (name) {
    case "arrow-left":
      return (
        <svg {...common}>
          <path d="M15 18l-6-6 6-6" />
          <path d="M10 12h10" />
        </svg>
      );
    case "cancel":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </svg>
      );
    case "cube":
      return (
        <svg {...common}>
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
          <path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" />
        </svg>
      );
    case "execution":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2.5" />
          <path d="M8 8h4M8 12h8M8 16h6" />
        </svg>
      );
    case "external":
      return (
        <svg {...common}>
          <path d="M14 4h6v6" />
          <path d="M20 4l-8 8" />
          <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4" />
        </svg>
      );
    case "layout":
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2.5" />
          <path d="M4 10h16M9 10v9" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path d="M8 5v14l11-7-11-7z" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "pulse":
      return (
        <svg {...common}>
          <path d="M3 12h4l2-7 5 14 2-7h5" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M20 11a8 8 0 10-2.3 5.7" />
          <path d="M20 5v6h-6" />
        </svg>
      );
    case "signal":
      return (
        <svg {...common}>
          <path d="M5 17h2" />
          <path d="M11 17h2v-5h-2z" />
          <path d="M17 17h2V7h-2z" />
        </svg>
      );
    case "team":
      return (
        <svg {...common}>
          <circle cx="9" cy="9" r="3" />
          <path d="M3.5 19a5.5 5.5 0 0111 0" />
          <path d="M16 11a2.5 2.5 0 100-5" />
          <path d="M17 14a4.5 4.5 0 013.5 4.5" />
        </svg>
      );
    case "timer":
      return (
        <svg {...common}>
          <rect x="5" y="7" width="14" height="13" rx="3" />
          <path d="M9 4h6M12 11v4l3 2" />
        </svg>
      );
    case "tray":
      return (
        <svg {...common}>
          <path d="M7 4h10l2 8v6a2 2 0 01-2 2H7a2 2 0 01-2-2v-6l2-8z" />
          <path d="M5 13h4l1.5 2h3L15 13h4" />
        </svg>
      );
  }
}

function navIcon(page: Page): IconName {
  switch (page) {
    case "overview":
      return "layout";
    case "agents":
      return "team";
    case "executions":
      return "execution";
    case "detail":
    case "agent-detail":
      return "execution";
  }
}

function StatusDot({ status, className = "" }: { status: string; className?: string }) {
  return (
    <span
      className={`status-dot status-dot--${getStatusTone(status)} ${className}`.trim()}
      title={status}
    />
  );
}

function StatusPill({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <span className={`status-pill__dot status-pill__dot--${tone}`} />
      {children}
    </span>
  );
}

function SchedulerStateCell({
  state,
  meta,
}: {
  state: string | null | undefined;
  meta?: string;
}) {
  const label = state || "not reported";
  return (
    <div className="scheduler-cell">
      <StatusPill tone={schedulerStateTone(state)}>{label}</StatusPill>
      {meta ? <span>{meta}</span> : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: string | number;
  meta: string;
  tone: StatusTone;
}) {
  return (
    <article className={`stat-card stat-card--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{meta}</p>
    </article>
  );
}

export function ExecutionFilterPanel({
  agents,
  values,
  loading,
  onChange,
  onReset,
}: {
  agents: Agent[];
  values: ExecutionFilterValues;
  loading: boolean;
  onChange: (patch: Partial<ExecutionFilterValues>) => void;
  onReset: () => void;
}) {
  return (
    <section className="panel execution-filter-panel">
      <header className="panel__header">
        <div>
          <span className="eyebrow">Filters</span>
          <h2>Execution Filters</h2>
          <p>Filter the execution log by agent, status, and trigger source.</p>
        </div>
        {loading ? <span className="panel__count">...</span> : null}
      </header>

      <div className="execution-filter-grid">
        <label className="control-field">
          <span>Agent</span>
          <select
            className="control-input control-select"
            value={values.agentId}
            onChange={(event) => onChange({ agentId: event.currentTarget.value })}
          >
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agentDisplayName(agent)}
              </option>
            ))}
          </select>
        </label>

        <label className="control-field">
          <span>Status</span>
          <select
            className="control-input control-select"
            value={values.status}
            onChange={(event) => onChange({ status: event.currentTarget.value })}
          >
            <option value="">All statuses</option>
            <option value="queued">queued</option>
            <option value="running">running</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
            <option value="timeout">timeout</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>

        <label className="control-field">
          <span>Trigger</span>
          <select
            className="control-input control-select"
            value={values.triggerType}
            onChange={(event) => onChange({ triggerType: event.currentTarget.value })}
          >
            <option value="">All triggers</option>
            <option value="cron">cron</option>
            <option value="manual">manual</option>
            <option value="api">api</option>
            <option value="agent">agent</option>
            <option value="retry">retry</option>
          </select>
        </label>
      </div>

      <footer className="execution-filter-footer">
        <button
          className="ghost-button ghost-button--compact"
          type="button"
          onClick={onReset}
          disabled={loading || !hasExecutionFilters(values)}
        >
          Reset Filters
        </button>
      </footer>
    </section>
  );
}

/* ── Page Navigation (Sidebar) ────────────────────────────────── */

function PageNavigation({
  activePage,
  pages,
  onNavigate,
}: {
  activePage: Page;
  pages: PageDefinition[];
  onNavigate: (p: Page) => void;
}) {
  const primaryPages = pages.filter((p) =>
    ["overview", "agents", "executions"].includes(p.id),
  );
  const secondaryPages = pages.filter(
    (p) => !["overview", "agents", "executions"].includes(p.id),
  );

  const renderButton = (pageDef: PageDefinition) => (
    <button
      key={pageDef.id}
      className={
        "page-nav__button" +
        (pageDef.id === activePage ? " page-nav__button--active" : "")
      }
      type="button"
      onClick={() => onNavigate(pageDef.id)}
    >
      <span className="page-nav__body">
        <Icon name={navIcon(pageDef.id)} className="page-nav__icon" />
        <span className="page-nav__label">{pageDef.label}</span>
      </span>
      {pageDef.badge ? (
        <span className="page-nav__badge">{pageDef.badge}</span>
      ) : null}
    </button>
  );

  return (
    <nav className="page-nav" aria-label="Page navigation">
      <div className="sidebar-brand">
        <span className="sidebar-brand__mark">
          <Icon name="cube" />
        </span>
        <span>Local-first control plane</span>
      </div>
      <div className="page-nav__group">
        <span className="page-nav__title">Workspace</span>
        {primaryPages.map(renderButton)}
      </div>
      {secondaryPages.length > 0 ? (
        <div className="page-nav__group">
          <span className="page-nav__title">Detail</span>
          {secondaryPages.map(renderButton)}
        </div>
      ) : null}
      <div className="sidebar-status-card">
        <strong>Agent Cron Hub</strong>
        <p>Monitor, schedule, and trigger cron-driven AI agents from a single dashboard.</p>
        <div>
          <span>v1.0.0</span>
          <span className="sidebar-status-card__live">
            <span />
            Live local
          </span>
        </div>
      </div>
    </nav>
  );
}

/* ── Execution Table ──────────────────────────────────────────── */

function ExecutionTable({
  executions,
  agents,
  onSelect,
  onCancel,
  onRerun,
  actionBusyExecutionId,
}: {
  executions: Execution[];
  agents: Agent[];
  onSelect: (e: Execution) => void;
  onCancel?: (e: Execution) => void;
  onRerun?: (e: Execution) => void;
  actionBusyExecutionId?: string | null;
}) {
  const agentName = (agentId: string) => {
    const a = agents.find((x) => x.id === agentId);
    return a ? agentDisplayName(a) : agentId.slice(0, 8);
  };
  const showActions = Boolean(onCancel || onRerun);

  if (!Array.isArray(executions) || executions.length === 0) {
    return (
      <div className="empty-state">
        <h3>No executions yet</h3>
        <p>Trigger an agent or wait for a cron schedule to produce executions.</p>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="runs-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Agent</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>Duration</th>
            {showActions ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {executions.map((e) => {
            const busy = actionBusyExecutionId === e.id;
            return (
              <tr
                key={e.id}
                onClick={() => onSelect(e)}
                style={{ cursor: "pointer" }}
              >
                <td>{formatTime(executionDisplayTime(e))}</td>
                <td>
                  <div className="table-primary">
                    <strong>{agentName(e.agentId)}</strong>
                  </div>
                </td>
                <td>{e.triggerType}</td>
                <td>
                  <StatusPill tone={getStatusTone(e.status)}>
                    {e.status}
                  </StatusPill>
                </td>
                <td>{e.durationMs ? `${e.durationMs}ms` : "-"}</td>
                {showActions ? (
                  <td>
                    <div className="action-group action-group--compact">
                      {onRerun ? (
                        <button
                          className="ghost-button ghost-button--compact"
                          disabled={busy}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onRerun(e);
                          }}
                        >
                          Rerun
                        </button>
                      ) : null}
                      {onCancel && canCancelExecution(e) ? (
                        <button
                          className="action-button action-button--cancel action-button--compact"
                          disabled={busy || isTerminalExecution(e.status)}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onCancel(e);
                          }}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ExecutionHistoryPager({
  visibleCount,
  canLoadMore,
  loading,
  onLoadMore,
}: {
  visibleCount: number;
  canLoadMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (visibleCount <= 0) return null;

  return (
    <footer className="execution-history-pager">
      <span>Showing {visibleCount} executions</span>
      <button
        className="ghost-button ghost-button--compact"
        type="button"
        disabled={loading || !canLoadMore}
        onClick={onLoadMore}
      >
        {loading ? "Loading..." : canLoadMore ? "Load More" : "All loaded"}
      </button>
    </footer>
  );
}

export function ExecutionSummaryPanel({ execution }: { execution: Execution }) {
  const progressPercent =
    typeof execution.progressPercent === "number"
      ? Math.max(0, Math.min(100, execution.progressPercent))
      : null;

  return (
    <div className="panel panel--execution-summary">
      <dl className="meta-grid">
        <div>
          <dt>Status</dt>
          <dd className="status-value">
            <StatusDot status={execution.status} />
            {execution.status}
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {execution.durationMs
              ? `${execution.durationMs}ms`
              : "N/A"}
          </dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>
            {execution.triggerType} &mdash;{" "}
            {execution.triggeredBy ?? "-"}
          </dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>{formatTime(execution.scheduledAt ?? null)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatTime(execution.startedAt)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatTime(execution.createdAt ?? null)}</dd>
        </div>
        <div>
          <dt>Traces recorded</dt>
          <dd>{execution.traceCountActual ?? 0}</dd>
        </div>
        {progressPercent !== null ? (
          <div className="meta-grid__wide">
            <dt>Progress</dt>
            <dd className="execution-progress">
              <div className="progress-stack">
                <div className="progress-bar" aria-hidden="true">
                  <span
                    className="progress-bar__fill"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <span>
                  {progressPercent}%
                  {execution.progressMessage ? ` - ${execution.progressMessage}` : ""}
                </span>
              </div>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Agent ID</dt>
          <dd className="truncate-path">{execution.agentId}</dd>
        </div>
      </dl>
      <div className="execution-illustration" aria-hidden="true">
        <div className="execution-illustration__calendar">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="execution-illustration__clock">
          <Icon name="timer" />
        </div>
      </div>
    </div>
  );
}

/* ── Agent Directory Panel ───────────────────────────────────── */

export function AlertPanel({
  alerts,
  onAcknowledge,
  actionBusyAlertId = null,
}: {
  alerts: AlertEntry[];
  onAcknowledge?: (alert: AlertEntry) => void;
  actionBusyAlertId?: number | null;
}) {
  const displayAlerts = visibleAlerts(alerts);

  return (
    <section className="panel alerts-panel">
      <header className="panel__header">
        <div>
          <span className="eyebrow">Alerts</span>
          <h2>Operational Alerts</h2>
          <p>Recent scheduler health signals from failed runs, queue pressure, and timeouts.</p>
        </div>
        <span className="panel__count">{displayAlerts.length}</span>
      </header>

      {displayAlerts.length === 0 ? (
        <div className="alerts-empty">
          <Icon name="pulse" />
          <div>
            <strong>No active alerts</strong>
            <p>The scheduler has not recorded recent failure patterns.</p>
          </div>
        </div>
      ) : (
        <ul className="alerts-list">
          {displayAlerts.slice(0, 6).map((alert) => {
            const tone = getAlertTone(alert.severity);
            return (
              <li className={`alert-item alert-item--${tone}`} key={alert.id}>
                <div className="alert-item__marker">
                  <Icon name="pulse" />
                </div>
                <div className="alert-item__body">
                  <div className="alert-item__title-row">
                    <strong>{alertDisplayName(alert)}</strong>
                    <StatusPill tone={tone}>{alert.severity}</StatusPill>
                  </div>
                  <p>{alert.message}</p>
                  <div className="alert-item__meta">
                    <span>{formatAlertRule(alert.ruleName)}</span>
                    <time dateTime={alert.createdAt ?? undefined}>
                      {formatTime(alert.createdAt)}
                    </time>
                  </div>
                  {onAcknowledge ? (
                    <div className="alert-item__actions">
                      <button
                        className="ghost-button ghost-button--compact"
                        type="button"
                        disabled={actionBusyAlertId === alert.id}
                        onClick={() => onAcknowledge(alert)}
                      >
                        {actionBusyAlertId === alert.id ? "Acknowledging..." : "Acknowledge"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AgentDirectoryPanel({
  agents,
  projects,
  schedulerStatus = null,
  eyebrow,
  title,
  description,
  emptyTitle,
  emptyDescription,
  actions,
  children,
  showLifecycleActions = true,
  deleteBusyAgentId = null,
  drainBusyAgentId = null,
  onOpenAgent,
  onToggleAgent,
  onTriggerAgent,
  onDrainAgent,
  onDeleteAgent,
}: {
  agents: Agent[];
  projects: Project[];
  schedulerStatus?: SchedulerStatusSnapshot | null;
  eyebrow: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  actions?: ReactNode;
  children?: ReactNode;
  showLifecycleActions?: boolean;
  deleteBusyAgentId?: string | null;
  drainBusyAgentId?: string | null;
  onOpenAgent: (agent: Agent) => void;
  onToggleAgent: (agentId: string, enabled: boolean) => void;
  onTriggerAgent: (agentName: string) => void;
  onDrainAgent?: (agent: Agent) => void;
  onDeleteAgent: (agent: Agent) => void;
}) {
  const schedulerById = schedulerStatusByAgentId(schedulerStatus);
  const showSchedulerDiagnostics = Boolean(schedulerStatus);

  return (
    <>
      <div className="page-context-bar">
        <div>
          <span className="page-context-bar__eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {actions ? <div className="page-context-bar__actions">{actions}</div> : null}
      </div>

      {children}

      <div className="panel">
        {agents.length === 0 ? (
          <div className="empty-state">
            <h3>{emptyTitle}</h3>
            <p>{emptyDescription}</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Agent</th>
                  <th>Cron</th>
                  <th>Status</th>
                  {showSchedulerDiagnostics ? (
                    <>
                      <th>Dispatch</th>
                      <th>Schedule</th>
                      <th>Queue</th>
                      <th>Capacity</th>
                    </>
                  ) : null}
                  <th>Last 10</th>
                  {showLifecycleActions ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => {
                  const deleting = deleteBusyAgentId === agent.id;
                  const draining = drainBusyAgentId === agent.id;
                  const schedulerAgentStatus = schedulerById.get(agent.id);
                  return (
                  <tr
                    key={agent.id}
                    onClick={() => onOpenAgent(agent)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      {agent.projectId
                        ? projectDisplayName(projects, agent.projectId)
                        : projectName(agent)}
                    </td>
                    <td>
                      <div className="table-primary">
                        <strong>{agentDisplayName(agent)}</strong>
                      </div>
                    </td>
                    <td>
                      <code>{agent.cronExpression || "manual"}</code>
                    </td>
                    <td>
                      <StatusPill tone={agentStatusTone(agent)}>
                        {agentStatusLabel(agent)}
                      </StatusPill>
                    </td>
                    {showSchedulerDiagnostics ? (
                      <>
                        <td>
                          <SchedulerStateCell
                            state={schedulerAgentStatus?.dispatchState}
                            meta={`${schedulerAgentStatus?.runningCount ?? 0} running`}
                          />
                        </td>
                        <td>
                          <SchedulerStateCell
                            state={schedulerAgentStatus?.scheduleState}
                            meta={
                              schedulerAgentStatus?.nextRunAt
                                ? `next ${formatTime(schedulerAgentStatus.nextRunAt)}`
                                : undefined
                            }
                          />
                        </td>
                        <td>{formatSchedulerQueue(schedulerAgentStatus)}</td>
                        <td>{formatSchedulerCapacity(schedulerAgentStatus)}</td>
                      </>
                    ) : null}
                    <td>
                      {(agent.recentExecutions ?? [])
                        .slice(0, 10)
                        .map((execution, index) => (
                          <StatusDot
                            key={index}
                            status={execution.status}
                            className="status-dot--tiny"
                          />
                        ))}
                    </td>
                    {showLifecycleActions ? (
                      <td>
                        <div className="action-group">
                          <button
                            className="ghost-button ghost-button--compact"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onToggleAgent(agent.id, !agent.enabled);
                            }}
                          >
                            {agent.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            className="action-button action-button--resume"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onTriggerAgent(agent.name);
                            }}
                          >
                            Run
                          </button>
                          {onDrainAgent ? (
                            <button
                              className="ghost-button ghost-button--compact"
                              type="button"
                              disabled={draining}
                              onClick={(event) => {
                                event.stopPropagation();
                                onDrainAgent(agent);
                              }}
                            >
                              {draining ? "Draining..." : "Drain"}
                            </button>
                          ) : null}
                          <button
                            className="action-button action-button--cancel action-button--compact"
                            type="button"
                            disabled={deleting}
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteAgent(agent);
                            }}
                          >
                            {deleting ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function AgentCreatePanel({
  projects,
  values,
  busy,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  projects: Project[];
  values: AgentCreateFormValues;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<AgentCreateFormValues>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="panel agent-create-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <header className="panel__header">
        <div>
          <h2>New Agent</h2>
          <p>Register a schedulable agent in the hub. The worker process can attach later through the SDK.</p>
        </div>
      </header>

      <div className="agent-create-grid">
        <label className="control-field">
          <span>Project</span>
          <select
            className="control-input control-select"
            value={values.projectId}
            onChange={(event) => onChange({ projectId: event.currentTarget.value })}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.displayName || project.name}
              </option>
            ))}
          </select>
        </label>

        <label className="control-field">
          <span>Type</span>
          <select
            className="control-input control-select"
            value={values.agentType}
            onChange={(event) => onChange({ agentType: event.currentTarget.value as AgentCreateFormValues["agentType"] })}
          >
            <option value="cron_task">cron_task</option>
            <option value="llm_agent">llm_agent</option>
          </select>
        </label>

        <label className="control-field control-field--wide">
          <span>Agent name</span>
          <input
            className="control-input"
            value={values.name}
            onChange={(event) => onChange({ name: event.currentTarget.value })}
            placeholder="daily_digest"
            required
          />
        </label>

        <label className="control-field control-field--wide">
          <span>Display name</span>
          <input
            className="control-input"
            value={values.displayName}
            onChange={(event) => onChange({ displayName: event.currentTarget.value })}
            placeholder="Daily Digest"
            required
          />
        </label>

        <label className="control-field control-field--wide">
          <span>Cron</span>
          <input
            className="control-input"
            value={values.cronExpression}
            onChange={(event) => onChange({ cronExpression: event.currentTarget.value })}
            placeholder="0 8 * * *"
          />
        </label>

        <label className="control-field control-field--wide">
          <span>Handler</span>
          <input
            className="control-input"
            value={values.handlerName}
            onChange={(event) => onChange({ handlerName: event.currentTarget.value })}
            placeholder="daily_digest"
          />
        </label>

        <label className="control-field">
          <span>Concurrency</span>
          <input
            className="control-input"
            type="number"
            min="1"
            value={values.concurrency}
            onChange={(event) => onChange({ concurrency: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Timeout</span>
          <input
            className="control-input"
            type="number"
            min="1"
            value={values.timeoutSeconds}
            onChange={(event) => onChange({ timeoutSeconds: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Retries</span>
          <input
            className="control-input"
            type="number"
            min="0"
            value={values.retryMax}
            onChange={(event) => onChange({ retryMax: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Queue cap</span>
          <input
            className="control-input"
            type="number"
            min="0"
            value={values.maxPendingQueue}
            onChange={(event) => onChange({ maxPendingQueue: event.currentTarget.value })}
          />
        </label>
      </div>

      {error ? (
        <div className="agent-create-error" role="alert">
          {error}
        </div>
      ) : null}

      <footer className="agent-create-footer">
        <button
          className="ghost-button ghost-button--compact"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className="action-button action-button--resume"
          type="submit"
          disabled={busy || projects.length === 0}
        >
          <Icon name="plus" />
          {busy ? "Creating..." : "Create agent"}
        </button>
      </footer>
    </form>
  );
}

export function AgentTriggerPanel({
  payloadText,
  busy,
  error,
  onPayloadChange,
  onSubmit,
}: {
  payloadText: string;
  busy: boolean;
  error: string | null;
  onPayloadChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="agent-runtime-section agent-trigger-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <header>
        <span className="agent-runtime-section__icon">
          <Icon name="play" />
        </span>
        <div>
          <h3>Manual Trigger</h3>
          <p>Run this agent with a dashboard-provided payload.</p>
        </div>
      </header>

      <label className="control-field agent-trigger-panel__field">
        <span>Payload JSON</span>
        <textarea
          className="control-input trigger-payload-input"
          value={payloadText}
          onChange={(event) => onPayloadChange(event.currentTarget.value)}
          spellCheck={false}
          rows={7}
        />
      </label>

      {error ? (
        <div className="agent-create-error agent-trigger-error" role="alert">
          {error}
        </div>
      ) : null}

      <footer className="agent-trigger-footer">
        <button className="action-button action-button--resume" type="submit" disabled={busy}>
          <Icon name="play" />
          {busy ? "Triggering..." : "Trigger Now"}
        </button>
      </footer>
    </form>
  );
}

export function AgentSettingsPanel({
  values,
  busy,
  error,
  onChange,
  onSubmit,
}: {
  values: AgentSettingsFormValues;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<AgentSettingsFormValues>) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="agent-runtime-section agent-settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <header>
        <span className="agent-runtime-section__icon">
          <Icon name="execution" />
        </span>
        <div>
          <h3>Agent Settings</h3>
          <p>Scheduling, queue, retry, and idempotency controls.</p>
        </div>
      </header>

      <div className="agent-settings-grid">
        <label className="control-field control-field--wide">
          <span>Display name</span>
          <input
            className="control-input"
            value={values.displayName}
            onChange={(event) => onChange({ displayName: event.currentTarget.value })}
          />
        </label>

        <label className="control-field control-field--wide">
          <span>Cron</span>
          <input
            className="control-input"
            value={values.cronExpression}
            onChange={(event) => onChange({ cronExpression: event.currentTarget.value })}
            placeholder="0 8 * * *"
          />
        </label>

        <label className="control-field control-field--wide">
          <span>Handler</span>
          <input
            className="control-input"
            value={values.handlerName}
            onChange={(event) => onChange({ handlerName: event.currentTarget.value })}
            placeholder="daily_digest"
          />
        </label>

        <label className="control-field">
          <span>Misfire</span>
          <select
            className="control-input control-select"
            value={values.misfirePolicy}
            onChange={(event) => onChange({ misfirePolicy: event.currentTarget.value as MisfirePolicy })}
          >
            <option value="fire_once">fire_once</option>
            <option value="fire_all">fire_all</option>
            <option value="drop">drop</option>
          </select>
        </label>

        <label className="control-field">
          <span>Concurrency</span>
          <input
            className="control-input"
            type="number"
            min="1"
            value={values.concurrency}
            onChange={(event) => onChange({ concurrency: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Queue cap</span>
          <input
            className="control-input"
            type="number"
            min="0"
            value={values.maxPendingQueue}
            onChange={(event) => onChange({ maxPendingQueue: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Timeout</span>
          <input
            className="control-input"
            type="number"
            min="1"
            value={values.timeoutSeconds}
            onChange={(event) => onChange({ timeoutSeconds: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Retries</span>
          <input
            className="control-input"
            type="number"
            min="0"
            value={values.retryMax}
            onChange={(event) => onChange({ retryMax: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Backoff</span>
          <input
            className="control-input"
            type="number"
            min="0"
            value={values.retryBackoffBaseMs}
            onChange={(event) => onChange({ retryBackoffBaseMs: event.currentTarget.value })}
          />
        </label>

        <label className="control-field">
          <span>Idempotency</span>
          <input
            className="control-input"
            type="number"
            min="1"
            value={values.idempotencyWindowSeconds}
            onChange={(event) => onChange({ idempotencyWindowSeconds: event.currentTarget.value })}
          />
        </label>
      </div>

      {error ? (
        <div className="agent-create-error agent-settings-error" role="alert">
          {error}
        </div>
      ) : null}

      <footer className="agent-settings-footer">
        <button className="action-button action-button--resume" type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save Settings"}
        </button>
      </footer>
    </form>
  );
}

export function ExecutionPayloadPanel({ payload }: { payload: unknown }) {
  const formattedPayload = JSON.stringify(payload ?? {}, null, 2);

  return (
    <div className="panel execution-payload-panel">
      <header className="panel__header traces-header">
        <div className="traces-heading">
          <span className="traces-heading__icon">
            <Icon name="tray" />
          </span>
          <div>
            <h2>Input Payload</h2>
            <p>Payload captured when this execution was queued.</p>
          </div>
        </div>
      </header>
      <pre className="execution-payload-json">{formattedPayload}</pre>
    </div>
  );
}

/* ── App ──────────────────────────────────────────────────────── */

export default function App() {
  /* page routing */
  const [page, setPage] = useState<Page>(() => {
    if (typeof window === "undefined") return "overview";
    const hash = window.location.hash.replace(/^#\/?/, "").trim();
    const valid: Page[] = [
      "overview",
      "agents",
      "executions",
      "detail",
      "agent-detail",
    ];
    return valid.includes(hash as Page) ? (hash as Page) : "overview";
  });

  /* data */
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [archivedAgents, setArchivedAgents] = useState<Agent[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [stats, setStats] = useState<DashboardStats>({});
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createAgentForm, setCreateAgentForm] = useState<AgentCreateFormValues>(() => initialAgentCreateForm());
  const [createAgentBusy, setCreateAgentBusy] = useState(false);
  const [createAgentError, setCreateAgentError] = useState<string | null>(null);
  const [actionBusyAlertId, setActionBusyAlertId] = useState<number | null>(null);
  const [executionFilters, setExecutionFilters] = useState<ExecutionFilterValues>(() => initialExecutionFilters());
  const [filteredExecutions, setFilteredExecutions] = useState<Execution[]>([]);
  const [executionFilterLoading, setExecutionFilterLoading] = useState(false);
  const [executionFilterError, setExecutionFilterError] = useState<string | null>(null);
  const [executionsHasMore, setExecutionsHasMore] = useState(false);
  const [filteredExecutionsHasMore, setFilteredExecutionsHasMore] = useState(false);
  const [executionHistoryLoadingMore, setExecutionHistoryLoadingMore] = useState(false);

  /* detail pages */
  const [selectedExecution, setSelectedExecution] =
    useState<Execution | null>(null);
  const [traces, setTraces] = useState<TraceSpan[]>([]);
  const [triggerChain, setTriggerChain] = useState<TriggerChainEntry[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [schedulePreview, setSchedulePreview] = useState<string[]>([]);
  const [schedulePreviewLoading, setSchedulePreviewLoading] = useState(false);
  const [actionBusyExecutionId, setActionBusyExecutionId] = useState<string | null>(null);
  const [triggerPayloadText, setTriggerPayloadText] = useState(DEFAULT_TRIGGER_PAYLOAD_TEXT);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggerBusyAgentId, setTriggerBusyAgentId] = useState<string | null>(null);
  const [deleteBusyAgentId, setDeleteBusyAgentId] = useState<string | null>(null);
  const [drainBusyAgentId, setDrainBusyAgentId] = useState<string | null>(null);
  const [agentSettingsForm, setAgentSettingsForm] = useState<AgentSettingsFormValues>(() => initialAgentSettingsForm());
  const [agentSettingsBusy, setAgentSettingsBusy] = useState(false);
  const [agentSettingsError, setAgentSettingsError] = useState<string | null>(null);

  /* websocket */
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("connecting");

  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const executionFilterRequestIdRef = useRef(0);
  const executionHistoryLimitRef = useRef(EXECUTION_PAGE_SIZE);
  const filteredExecutionLimitRef = useRef(EXECUTION_PAGE_SIZE);

  /* hash-based routing */
  useEffect(() => {
    const handler = () => {
      const hash = window.location.hash.replace(/^#\/?/, "").trim();
      const valid: Page[] = [
        "overview",
        "agents",
        "executions",
        "detail",
        "agent-detail",
      ];
      if (valid.includes(hash as Page)) setPage(hash as Page);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  useEffect(() => {
    const nextHash = `#${page}`;
    if (window.location.hash === nextHash) return;
    const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
    if (window.location.hash.length === 0) {
      window.history.replaceState(null, "", nextUrl);
    } else {
      window.history.pushState(null, "", nextUrl);
    }
  }, [page]);

  /* data loading */
  const loadData = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current;
    if (!silent) setLoading(true);
    setError(null);

    try {
      const executionLimit = executionHistoryLimitRef.current;
      const [p, a, archived, e, s, al, scheduler] = await Promise.all([
        fetchProjects(),
        fetchAgents(),
        fetchAgents({ archived: "only" }),
        fetchExecutions({ limit: String(executionLimit) }),
        fetchStats(),
        fetchAlerts({ limit: "10" }),
        fetchSchedulerStatus(),
      ]);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const executionList = Array.isArray(e) ? e : [];
      setProjects(Array.isArray(p) ? p : []);
      setAgents(Array.isArray(a) ? a : []);
      setArchivedAgents(Array.isArray(archived) ? archived : []);
      setExecutions(executionList);
      setExecutionsHasMore(executionList.length >= executionLimit);
      setStats(s || {});
      setAlerts(Array.isArray(al) ? al : []);
      setSchedulerStatus(
        scheduler && Array.isArray((scheduler as SchedulerStatusSnapshot).agents)
          ? (scheduler as SchedulerStatusSnapshot)
          : null,
      );
      setLastSyncedAt(new Date().toISOString());
    } catch (err: unknown) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const loadFilteredExecutions = useCallback(async (
    values: ExecutionFilterValues,
    options: ExecutionLoadOptions = {},
  ) => {
    const append = Boolean(options.append);
    const limit = options.limit ?? filteredExecutionLimitRef.current;
    const offset = options.offset ?? 0;
    const requestId = ++executionFilterRequestIdRef.current;
    if (append) {
      setExecutionHistoryLoadingMore(true);
    } else {
      setExecutionFilterLoading(true);
    }
    setExecutionFilterError(null);
    try {
      const result = await fetchExecutions(executionQueryParamsFromFilters(values, { limit, offset }));
      if (!mountedRef.current || requestId !== executionFilterRequestIdRef.current) return;
      const nextExecutions = Array.isArray(result) ? result : [];
      if (append) {
        setFilteredExecutions((current) => current.concat(nextExecutions));
        filteredExecutionLimitRef.current = offset + nextExecutions.length;
      } else {
        setFilteredExecutions(nextExecutions);
        filteredExecutionLimitRef.current = limit;
      }
      setFilteredExecutionsHasMore(nextExecutions.length >= limit);
    } catch (err: unknown) {
      if (!mountedRef.current || requestId !== executionFilterRequestIdRef.current) return;
      if (!append) setFilteredExecutions([]);
      setExecutionFilterError(errorMessage(err));
    } finally {
      if (mountedRef.current && requestId === executionFilterRequestIdRef.current) {
        if (append) {
          setExecutionHistoryLoadingMore(false);
        } else {
          setExecutionFilterLoading(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (page !== "executions") return;
    if (!hasExecutionFilters(executionFilters)) {
      executionFilterRequestIdRef.current += 1;
      filteredExecutionLimitRef.current = EXECUTION_PAGE_SIZE;
      setFilteredExecutions([]);
      setFilteredExecutionsHasMore(false);
      setExecutionFilterError(null);
      setExecutionFilterLoading(false);
      return;
    }
    loadFilteredExecutions(executionFilters);
  }, [executionFilters, loadFilteredExecutions, page]);

  useEffect(() => {
    if (!lastSyncedAt) return;
    if (page !== "executions") return;
    if (!hasExecutionFilters(executionFilters)) return;
    loadFilteredExecutions(executionFilters, { limit: filteredExecutionLimitRef.current });
  }, [executionFilters, lastSyncedAt, loadFilteredExecutions, page]);

  useEffect(() => {
    if (createAgentForm.projectId || projects.length === 0) return;
    setCreateAgentForm((current) => (
      current.projectId ? current : { ...current, projectId: projects[0].id }
    ));
  }, [createAgentForm.projectId, projects]);

  useEffect(() => {
    setTriggerError(null);
    setTriggerPayloadText(DEFAULT_TRIGGER_PAYLOAD_TEXT);
    setAgentSettingsError(null);
    setAgentSettingsForm(selectedAgent ? agentSettingsFormFromAgent(selectedAgent) : initialAgentSettingsForm());
  }, [selectedAgent]);

  /* WebSocket connection */
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let alive = true;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleRefresh = () => {
      setTimeout(() => loadData(true), 500);
    };

    const scheduleReconnect = () => {
      if (!alive || reconnectTimer !== null) return;
      setSocketStatus("reconnecting");
      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (!alive) return;
      setSocketStatus(
        reconnectAttempt === 0 ? "connecting" : "reconnecting",
      );

      try {
        ws = connectSocket();
      } catch {
        setSocketStatus("error");
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        reconnectAttempt = 0;
        if (!alive) return;
        setSocketStatus("open");
      };

      ws.onmessage = () => {
        if (!alive) return;
        scheduleRefresh();
      };

      ws.onerror = () => {
        if (!alive) return;
        setSocketStatus("error");
      };

      ws.onclose = () => {
        if (!alive) return;
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      alive = false;
      clearReconnectTimer();
      if (ws) {
        const socket = ws;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.onopen = () => socket.close();
        } else {
          socket.close();
        }
      }
    };
  }, [loadData]);

  /* polling fallback */
  useEffect(() => {
    const interval = setInterval(() => loadData(true), 10_000);
    return () => clearInterval(interval);
  }, [loadData]);

  /* cleanup */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* actions */
  const updateExecutionFilters = useCallback((patch: Partial<ExecutionFilterValues>) => {
    filteredExecutionLimitRef.current = EXECUTION_PAGE_SIZE;
    setFilteredExecutionsHasMore(false);
    setExecutionFilters((current) => ({ ...current, ...patch }));
  }, []);

  const resetExecutionFilters = useCallback(() => {
    filteredExecutionLimitRef.current = EXECUTION_PAGE_SIZE;
    setFilteredExecutionsHasMore(false);
    setExecutionFilters(initialExecutionFilters());
  }, []);

  const handleLoadMoreExecutionHistory = async () => {
    setError(null);
    if (hasExecutionFilters(executionFilters)) {
      await loadFilteredExecutions(executionFilters, {
        append: true,
        limit: EXECUTION_PAGE_SIZE,
        offset: filteredExecutions.length,
      });
      return;
    }

    const offset = executions.length;
    setExecutionHistoryLoadingMore(true);
    try {
      const result = await fetchExecutions({
        limit: String(EXECUTION_PAGE_SIZE),
        offset: String(offset),
      });
      if (!mountedRef.current) return;
      const nextExecutions = Array.isArray(result) ? result : [];
      setExecutions((current) => current.concat(nextExecutions));
      executionHistoryLimitRef.current = offset + nextExecutions.length;
      setExecutionsHasMore(nextExecutions.length >= EXECUTION_PAGE_SIZE);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (mountedRef.current) setExecutionHistoryLoadingMore(false);
    }
  };

  const handleToggleAgent = async (agentId: string, enabled: boolean) => {
    const updated = await patchAgent(agentId, { enabled });
    if (updated?.id === selectedAgent?.id) {
      setSelectedAgent(updated);
    }
    loadData(true);
  };

  const handleTriggerAgent = async (name: string, payload: Record<string, unknown> = {}) => {
    await triggerAgent(name, payload);
    loadData(true);
  };

  const handleDrainAgent = async (agent: Agent) => {
    const confirmed = window.confirm(`Drain agent "${agentDisplayName(agent)}"? Queued executions will be cancelled and scheduling will be disabled.`);
    if (!confirmed) return;
    const cancelRunning = agent.activeExecutionCount > 0
      ? window.confirm(`Also cancel running executions for "${agentDisplayName(agent)}"?`)
      : false;

    setDrainBusyAgentId(agent.id);
    setError(null);
    try {
      await drainAgent(agent.id, { cancelRunning });
      await loadData(true);
      if (selectedAgent?.id === agent.id) {
        const refreshed = await fetchAgents();
        const next = Array.isArray(refreshed)
          ? refreshed.find((item: Agent) => item.id === agent.id)
          : null;
        if (next) setSelectedAgent(next);
      }
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setDrainBusyAgentId(null);
    }
  };

  const handleDeleteAgent = async (agent: Agent) => {
    const confirmed = window.confirm(`Delete agent "${agentDisplayName(agent)}"? This cannot be undone.`);
    if (!confirmed) return;

    setDeleteBusyAgentId(agent.id);
    setError(null);
    try {
      await deleteAgent(agent.id);
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      if (selectedAgent?.id === agent.id) {
        setSelectedAgent(null);
        setPage("agents");
      }
      await loadData(true);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setDeleteBusyAgentId(null);
    }
  };

  const handleSubmitAgentTrigger = async (agent: Agent) => {
    let payload: Record<string, unknown>;
    try {
      payload = parseTriggerPayload(triggerPayloadText);
    } catch (err: unknown) {
      setTriggerError(errorMessage(err));
      return;
    }

    setTriggerBusyAgentId(agent.id);
    setTriggerError(null);
    try {
      await handleTriggerAgent(agent.name, payload);
    } catch (err: unknown) {
      setTriggerError(errorMessage(err));
    } finally {
      setTriggerBusyAgentId(null);
    }
  };

  const refreshSchedulePreview = async (agent: Agent) => {
    setSchedulePreviewLoading(Boolean(agent.cronExpression && !agent.archivedAt));
    if (!agent.cronExpression || agent.archivedAt) {
      setSchedulePreview([]);
      return;
    }

    try {
      const preview = await fetchSchedulePreview(agent.id, 5);
      setSchedulePreview(Array.isArray(preview.runs) ? preview.runs : []);
    } catch {
      setSchedulePreview([]);
    } finally {
      setSchedulePreviewLoading(false);
    }
  };

  const handleSaveAgentSettings = async (agent: Agent) => {
    let patch: ReturnType<typeof agentSettingsPatchFromForm>;
    try {
      patch = agentSettingsPatchFromForm(agentSettingsForm);
    } catch (err: unknown) {
      setAgentSettingsError(errorMessage(err));
      return;
    }

    setAgentSettingsBusy(true);
    setAgentSettingsError(null);
    try {
      const updated = await patchAgent(agent.id, patch);
      if (!updated?.id) {
        throw new Error(updated?.error ?? "Failed to update agent settings");
      }
      const updatedAgent = updated as Agent;
      setSelectedAgent(updatedAgent);
      setAgentSettingsForm(agentSettingsFormFromAgent(updatedAgent));
      setAgents((current) => current.map((item) => (
        item.id === updatedAgent.id ? { ...item, ...updatedAgent } : item
      )));
      await refreshSchedulePreview(updatedAgent);
      await loadData(true);
    } catch (err: unknown) {
      setAgentSettingsError(errorMessage(err));
    } finally {
      setAgentSettingsBusy(false);
    }
  };

  const handleAcknowledgeAlert = async (alert: AlertEntry) => {
    setActionBusyAlertId(alert.id);
    setError(null);
    try {
      await acknowledgeAlert(alert.id);
      await loadData(true);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setActionBusyAlertId(null);
    }
  };

  const handleCreateAgent = async () => {
    const selectedProjectId = createAgentForm.projectId || projects[0]?.id;
    const name = createAgentForm.name.trim();
    const displayName = createAgentForm.displayName.trim();

    if (!selectedProjectId) {
      setCreateAgentError("No active project is available.");
      return;
    }
    if (!name || !displayName) {
      setCreateAgentError("Agent name and display name are required.");
      return;
    }

    setCreateAgentBusy(true);
    setCreateAgentError(null);
    try {
      await createAgent({
        projectId: selectedProjectId,
        name,
        displayName,
        agentType: createAgentForm.agentType,
        cronExpression: createAgentForm.cronExpression.trim() || null,
        handlerName: createAgentForm.handlerName.trim() || null,
        concurrency: parseIntegerWithMin(createAgentForm.concurrency, 1, 1),
        timeoutSeconds: parseIntegerWithMin(createAgentForm.timeoutSeconds, 600, 1),
        retryMax: parseIntegerWithMin(createAgentForm.retryMax, 3, 0),
        maxPendingQueue: parseIntegerWithMin(createAgentForm.maxPendingQueue, 100, 0),
      });
      await loadData(true);
      setCreateAgentForm(initialAgentCreateForm(selectedProjectId));
      setCreateAgentOpen(false);
    } catch (err: unknown) {
      setCreateAgentError(errorMessage(err));
    } finally {
      setCreateAgentBusy(false);
    }
  };

  const handleCancelExecution = async (execution: Execution) => {
    setActionBusyExecutionId(execution.id);
    setError(null);
    try {
      await cancelExecution(execution.id);
      await loadData(true);
      if (selectedExecution?.id === execution.id) {
        const updated = await fetchExecutionDetail(execution.id);
        setSelectedExecution(updated);
      }
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setActionBusyExecutionId(null);
    }
  };

  const handleRerunExecution = async (execution: Execution) => {
    setActionBusyExecutionId(execution.id);
    setError(null);
    try {
      const rerun = await rerunExecution(execution.id);
      await loadData(true);
      if (rerun.execution_id) {
        const created = await fetchExecutionDetail(rerun.execution_id);
        setSelectedExecution(created);
        setTraces([]);
        setTriggerChain([]);
        setPage("detail");
      }
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setActionBusyExecutionId(null);
    }
  };

  const handleViewRawTraces = () => {
    const rawWindow = window.open("", "_blank", "noopener,noreferrer");
    if (!rawWindow) return;
    const pre = rawWindow.document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
    pre.style.padding = "20px";
    pre.textContent = JSON.stringify(traces, null, 2);
    rawWindow.document.body.append(pre);
    rawWindow.document.close();
  };

  /* detail navigation */
  const openDetail = async (e: Execution) => {
    setSelectedExecution(e);
    setTraces([]);
    setTriggerChain([]);
    setPage("detail");
    try {
      const [t, chain] = await Promise.all([
        fetchTraces(e.id),
        fetchTriggerChain(e.id),
      ]);
      setTraces(Array.isArray(t) ? t : []);
      setTriggerChain(Array.isArray(chain) ? chain : []);
    } catch {
      setTraces([]);
      setTriggerChain([]);
    }
  };

  const openAgentDetail = async (a: Agent) => {
    const isArchived = Boolean(a.archivedAt);
    setSelectedAgent(a);
    setSchedulePreview([]);
    setPage("agent-detail");
    setSchedulePreviewLoading(Boolean(a.cronExpression && !isArchived));

    if (isArchived) {
      try {
        const detail = await fetchAgentDetail(a.id, { includeArchived: true });
        if (detail?.id) setSelectedAgent(detail as Agent);
      } catch (err: unknown) {
        setError(errorMessage(err));
      } finally {
        setSchedulePreviewLoading(false);
      }
      return;
    }

    if (!a.cronExpression) return;

    try {
      const preview = await fetchSchedulePreview(a.id, 5);
      setSchedulePreview(Array.isArray(preview.runs) ? preview.runs : []);
    } catch {
      setSchedulePreview([]);
    } finally {
      setSchedulePreviewLoading(false);
    }
  };

  /* computed values */
  const pageDefinitions: PageDefinition[] = (() => {
    const backPage: PageDefinition | null =
      page === "detail" || page === "agent-detail"
        ? {
            id: page,
            label: page === "detail" ? "Execution Detail" : "Agent Detail",
            description: "",
          }
        : null;

    return [
      {
        id: "overview",
        label: "Overview",
        description: "High-level snapshot of agent health and recent activity.",
        badge: String(agents.length),
      },
      {
        id: "agents",
        label: "Agents",
        description: "Browse agents, cron schedules, and trigger runs.",
        badge: String(agents.length),
      },
      {
        id: "executions",
        label: "Executions",
        description: "Full execution history across all agents.",
        badge: String(executions.length),
      },
      ...(backPage ? [backPage] : []),
    ];
  })();

  const agentsOnline = agents.filter(
    (a) => a.executorStatus === "online",
  ).length;

  const allKnownAgents = [
    ...agents,
    ...archivedAgents.filter((archived) => !agents.some((agent) => agent.id === archived.id)),
    ...(selectedAgent && !agents.some((agent) => agent.id === selectedAgent.id)
      && !archivedAgents.some((agent) => agent.id === selectedAgent.id)
      ? [selectedAgent]
      : []),
  ];

  const chainAgentName = (agentId: string) => {
    const agent = allKnownAgents.find((a) => a.id === agentId);
    return agent ? agentDisplayName(agent) : agentId.slice(0, 8) || "-";
  };

  const schedulerRunningCount = schedulerStatus?.agents.reduce(
    (total, agentStatus) => total + (agentStatus.runningCount ?? 0),
    0,
  );
  const runningCount = schedulerRunningCount ?? executions.filter(
    (e) => e.status === "running",
  ).length;

  const recentFailures =
    stats.recentFailures ?? executions.filter(
      (e) =>
        e.status === "failed" ||
        e.status === "timeout" ||
        e.status === "error",
    ).length;

  const executionFiltersActive = hasExecutionFilters(executionFilters);
  const executionPageExecutions = executionFiltersActive
    ? filteredExecutions
    : executions;
  const executionPageHasMore = executionFiltersActive
    ? filteredExecutionsHasMore
    : executionsHasMore;

  /* render */
  return (
    <div className="dashboard-shell">
      {/* ── Workspace ────────────────────────────────────── */}
      <div className="workspace-frame">
        <aside className="workspace-sidebar">
          <PageNavigation
            activePage={page}
            pages={pageDefinitions}
            onNavigate={(p) => {
              if (p === "detail" || p === "agent-detail") return; // only reachable via click
              setSelectedExecution(null);
              setSelectedAgent(null);
              setTraces([]);
              setTriggerChain([]);
              setSchedulePreview([]);
              setPage(p);
            }}
          />
        </aside>

        <main className="workspace-main">
          {/* ── Header ────────────────────────────────────────── */}
          <header className="app-header app-header--compact">
            <div className="app-header__copy">
              <div className="app-header__title-row">
                <h1>Agent Cron Hub</h1>
                <StatusPill tone={loading ? "neutral" : "success"}>
                  {loading ? "Loading..." : "Live local"}
                </StatusPill>
              </div>
              <p className="subtitle">
                Monitor, schedule, and trigger cron-driven AI agents from a single dashboard.
              </p>
            </div>

            <div className="app-header__meta">
              <StatusPill tone={getSocketTone(socketStatus)}>
                {socketStatusLabel(socketStatus)}
              </StatusPill>
              <button
                className="ghost-button"
                onClick={() => loadData(true)}
                disabled={loading}
              >
                <Icon name="refresh" />
                Refresh snapshot
              </button>
            </div>
          </header>

          {/* error banner */}
          {error ? (
            <div className="banner banner--error" role="alert">
              <div>
                <strong>Dashboard sync issue</strong>
                <p>{error}</p>
              </div>
              <button
                className="ghost-button ghost-button--light"
                onClick={() => loadData()}
              >
                Retry now
              </button>
            </div>
          ) : null}

          {/* loading */}
          {loading ? (
            <div className="loading-state">
              <div className="loading-spinner" />
              <p>Loading dashboard…</p>
            </div>
          ) : null}

          {/* ═══ OVERVIEW ═══ */}
          {!loading && page === "overview" && (
            <>
              {/* Stat cards */}
              <div className="summary-grid">
                <StatCard
                  label="Agents"
                  value={stats.agentsTotal ?? agents.length}
                  meta={`${agentsOnline} online`}
                  tone="info"
                />
                <StatCard
                  label="Online"
                  value={agentsOnline}
                  meta={`of ${agents.length} total`}
                  tone="success"
                />
                <StatCard
                  label="Running"
                  value={runningCount}
                  meta="active executions"
                  tone={runningCount > 0 ? "info" : "neutral"}
                />
                <StatCard
                  label="Failed (24h)"
                  value={recentFailures}
                  meta="recent failures"
                  tone={recentFailures > 0 ? "danger" : "success"}
                />
              </div>

              <AlertPanel
                alerts={alerts}
                onAcknowledge={handleAcknowledgeAlert}
                actionBusyAlertId={actionBusyAlertId}
              />

              <AgentDirectoryPanel
                agents={agents}
                projects={projects}
                schedulerStatus={schedulerStatus}
                eyebrow="Agents"
                title="Agent Status"
                description="All registered agents, executor status, schedules, and quick actions."
                emptyTitle="No agents registered"
                emptyDescription="Agents will appear here once they connect or are configured."
                deleteBusyAgentId={deleteBusyAgentId}
                drainBusyAgentId={drainBusyAgentId}
                onOpenAgent={openAgentDetail}
                onToggleAgent={handleToggleAgent}
                onTriggerAgent={handleTriggerAgent}
                onDrainAgent={handleDrainAgent}
                onDeleteAgent={handleDeleteAgent}
              />
            </>
          )}

          {/* ═══ AGENTS ═══ */}
          {!loading && page === "agents" && (
            <>
              <AgentDirectoryPanel
                agents={agents}
                projects={projects}
                schedulerStatus={schedulerStatus}
                eyebrow="Directory"
                title="Agents"
                description="Each agent has a cron expression, online/offline status, and recent execution dots."
                emptyTitle="No agents registered"
                emptyDescription="Agents will appear here once they connect or are configured."
                actions={
                  <button
                    className="action-button action-button--resume"
                    type="button"
                    onClick={() => {
                      setCreateAgentError(null);
                      setCreateAgentOpen((open) => !open);
                    }}
                  >
                    <Icon name="plus" />
                    New Agent
                  </button>
                }
                onOpenAgent={openAgentDetail}
                onToggleAgent={handleToggleAgent}
                onTriggerAgent={handleTriggerAgent}
                onDrainAgent={handleDrainAgent}
                onDeleteAgent={handleDeleteAgent}
                deleteBusyAgentId={deleteBusyAgentId}
                drainBusyAgentId={drainBusyAgentId}
              >
                {createAgentOpen ? (
                  <AgentCreatePanel
                    projects={projects}
                    values={createAgentForm}
                    busy={createAgentBusy}
                    error={createAgentError}
                    onChange={(patch) => setCreateAgentForm((current) => ({ ...current, ...patch }))}
                    onSubmit={handleCreateAgent}
                    onCancel={() => {
                      setCreateAgentOpen(false);
                      setCreateAgentError(null);
                    }}
                  />
                ) : null}
              </AgentDirectoryPanel>

              <AgentDirectoryPanel
                agents={archivedAgents}
                projects={projects}
                eyebrow="Archive"
                title="Archived Agents"
                description="Archived agents are hidden from scheduling but keep execution history."
                emptyTitle="No archived agents"
                emptyDescription="Deleted agents will appear here after they have no active executions."
                showLifecycleActions={false}
                onOpenAgent={openAgentDetail}
                onToggleAgent={handleToggleAgent}
                onTriggerAgent={handleTriggerAgent}
                onDeleteAgent={handleDeleteAgent}
              />
            </>
          )}

          {/* ═══ EXECUTIONS ═══ */}
          {!loading && page === "executions" && (
            <>
              <div className="page-context-bar">
                <div>
                  <span className="page-context-bar__eyebrow">History</span>
                  <h2>Executions</h2>
                  <p>
                    Full execution log. Click any row to open the trace viewer.
                  </p>
                </div>
              </div>

              <ExecutionFilterPanel
                agents={agents}
                values={executionFilters}
                loading={executionFilterLoading}
                onChange={updateExecutionFilters}
                onReset={resetExecutionFilters}
              />

              {executionFilterError ? (
                <div className="banner banner--error" role="alert">
                  <div>
                    <strong>Execution filter issue</strong>
                    <p>{executionFilterError}</p>
                  </div>
                  <button
                    className="ghost-button ghost-button--light"
                    onClick={() => loadFilteredExecutions(executionFilters)}
                  >
                    Retry now
                  </button>
                </div>
              ) : null}

              <div className="panel">
                <ExecutionTable
                  executions={executionPageExecutions}
                  agents={allKnownAgents}
                  onSelect={openDetail}
                  onCancel={handleCancelExecution}
                  onRerun={handleRerunExecution}
                  actionBusyExecutionId={actionBusyExecutionId}
                />
                <ExecutionHistoryPager
                  visibleCount={executionPageExecutions.length}
                  canLoadMore={executionPageHasMore}
                  loading={executionHistoryLoadingMore}
                  onLoadMore={handleLoadMoreExecutionHistory}
                />
              </div>
            </>
          )}

          {/* ═══ DETAIL (Trace Viewer) ═══ */}
          {!loading && page === "detail" && selectedExecution && (
            <>
              <div className="page-context-bar page-context-bar--detail">
                <div>
                  <button
                    className="ghost-button ghost-button--compact"
                    style={{ marginBottom: 8 }}
                    onClick={() => setPage("executions")}
                  >
                    <Icon name="arrow-left" />
                    Back to Executions
                  </button>
                  <h2>Execution Detail</h2>
                  <p>
                    Status, timing, and trace spans for this execution.
                  </p>
                </div>
                <div className="detail-action-bar">
                  <StatusPill tone={getStatusTone(selectedExecution.status)}>
                    {selectedExecution.status}
                  </StatusPill>
                  <div className="action-group">
                    <button
                      className="ghost-button ghost-button--compact"
                      disabled={actionBusyExecutionId === selectedExecution.id}
                      onClick={() => handleRerunExecution(selectedExecution)}
                    >
                      <Icon name="play" />
                      Rerun
                    </button>
                    {canCancelExecution(selectedExecution) ? (
                      <button
                        className="action-button action-button--cancel action-button--compact"
                        disabled={actionBusyExecutionId === selectedExecution.id}
                        onClick={() => handleCancelExecution(selectedExecution)}
                      >
                        <Icon name="cancel" />
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              <>
                <ExecutionSummaryPanel execution={selectedExecution} />
                {selectedExecution.errorMessage ? (
                  <div
                    className="banner banner--error"
                    role="alert"
                    style={{ marginTop: 16 }}
                  >
                    <div>
                      <strong>Error</strong>
                      <p>{selectedExecution.errorMessage}</p>
                    </div>
                  </div>
                ) : null}

                {selectedExecution.resultSummary ? (
                  <div
                    className="banner banner--info"
                    style={{ marginTop: 16 }}
                  >
                    <div>
                      <strong>Result</strong>
                      <p>{selectedExecution.resultSummary}</p>
                    </div>
                  </div>
                ) : null}
              </>

              <ExecutionPayloadPanel payload={selectedExecution.inputPayload} />

              <div className="panel">
                <header className="panel__header traces-header">
                  <div className="traces-heading">
                    <span className="traces-heading__icon">
                      <Icon name="execution" />
                    </span>
                    <div>
                      <h2>Trigger Chain</h2>
                      <p>Upstream and downstream executions linked to this run.</p>
                    </div>
                  </div>
                </header>

                {triggerChain.length === 0 ? (
                  <div className="trigger-chain-empty">
                    No linked executions recorded.
                  </div>
                ) : (
                  <ol className="trigger-chain-list">
                    {triggerChain.map((entry) => {
                      const agentId = triggerChainAgentId(entry);
                      const isCurrent = entry.id === selectedExecution.id;
                      return (
                        <li
                          key={entry.id}
                          className={isCurrent ? "trigger-chain-item trigger-chain-item--current" : "trigger-chain-item"}
                        >
                          <div className="trigger-chain-item__marker">
                            {triggerChainDepth(entry)}
                          </div>
                          <div className="trigger-chain-item__body">
                            <div className="trigger-chain-item__headline">
                              <strong>{chainAgentName(agentId)}</strong>
                              <StatusPill tone={getStatusTone(entry.status ?? "queued")}>
                                {entry.status ?? "unknown"}
                              </StatusPill>
                            </div>
                            <p>
                              {triggerChainTriggerType(entry)} &mdash; {triggerChainTriggeredBy(entry)}
                            </p>
                            <span>{formatTime(triggerChainTime(entry))}</span>
                          </div>
                          {!isCurrent ? (
                            <button
                              className="ghost-button ghost-button--compact"
                              onClick={() => {
                                void fetchExecutionDetail(entry.id).then(openDetail);
                              }}
                            >
                              Open
                            </button>
                          ) : (
                            <span className="trigger-chain-item__current-label">Current</span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              {/* Traces */}
              <div className="panel">
                <header className="panel__header traces-header">
                  <div className="traces-heading">
                    <span className="traces-heading__icon">
                      <Icon name="pulse" />
                    </span>
                    <div>
                      <h2>Traces</h2>
                      <p>Span-level details captured during this execution.</p>
                    </div>
                  </div>
                  <button
                    className="ghost-button ghost-button--compact"
                    onClick={handleViewRawTraces}
                  >
                    View raw
                    <Icon name="external" />
                  </button>
                </header>

                {!Array.isArray(traces) || traces.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-state__icon">
                      <Icon name="tray" />
                    </span>
                    <h3>No traces recorded</h3>
                    <p>
                      This execution did not produce any trace spans.
                    </p>
                  </div>
                ) : (
                  <ul className="timeline-list">
                    {traces.map((t, i) => {
                      const turnIndex = t.turnIndex ?? t.turn_index ?? 0;
                      const spanIndex = t.spanIndex ?? t.span_index ?? 0;
                      const spanType = t.spanType ?? t.span_type ?? "span";
                      const latencyMs = t.latencyMs ?? t.latency_ms;
                      const inputContent = t.inputContent ?? t.input_content;
                      const outputContent = t.outputContent ?? t.output_content;
                      const inputTokens = t.inputTokens ?? t.input_tokens;
                      const outputTokens = t.outputTokens ?? t.output_tokens;

                      return (
                      <li key={i} className="timeline-item">
                        <div
                          className={`event-dot event-dot--${getStatusTone(
                            t.status ?? "neutral",
                          )}`}
                        />
                        <div className="timeline-item__body">
                          <p>
                            <strong>
                              Turn {turnIndex}.{spanIndex}
                            </strong>{" "}
                            &mdash; {spanType} ({t.role ?? "unknown"})
                            {t.model ? ` &mdash; ${t.model}` : ""}
                            {latencyMs
                              ? ` &mdash; ${latencyMs}ms`
                              : ""}
                          </p>
                          {inputContent ? (
                            <details>
                              <summary>Input</summary>
                              <pre
                                style={{
                                  whiteSpace: "pre-wrap",
                                  maxHeight: 200,
                                  overflow: "auto",
                                  background: "rgba(15,23,42,0.62)",
                                  padding: "0.75rem",
                                  borderRadius: 12,
                                  marginTop: 8,
                                  fontSize: "0.82rem",
                                }}
                            >
                                {inputContent.slice(0, 2000)}
                              </pre>
                            </details>
                          ) : null}
                          {outputContent ? (
                            <details>
                              <summary>Output</summary>
                              <pre
                                style={{
                                  whiteSpace: "pre-wrap",
                                  maxHeight: 200,
                                  overflow: "auto",
                                  background: "rgba(15,23,42,0.62)",
                                  padding: "0.75rem",
                                  borderRadius: 12,
                                  marginTop: 8,
                                  fontSize: "0.82rem",
                                }}
                            >
                                {outputContent.slice(0, 2000)}
                              </pre>
                            </details>
                          ) : null}
                          <div className="timeline-item__meta">
                            {inputTokens != null
                              ? `${inputTokens} in`
                              : ""}
                            {outputTokens != null
                              ? ` / ${outputTokens} out`
                              : ""}
                          </div>
                        </div>
                      </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}

          {/* ═══ AGENT DETAIL ═══ */}
          {!loading && page === "agent-detail" && selectedAgent && (
            <>
              <div className="page-context-bar">
                <div>
                  <button
                    className="ghost-button ghost-button--compact"
                    style={{ marginBottom: 8 }}
                    onClick={() => setPage("agents")}
                  >
                    &larr; Back to Agents
                  </button>
                  <h2>{agentDisplayName(selectedAgent)}</h2>
                  <p>Agent configuration, status, and recent executions.</p>
                </div>
                <StatusPill
                  tone={agentStatusTone(selectedAgent)}
                >
                  {agentStatusLabel(selectedAgent)}
                </StatusPill>
              </div>

              <div className="panel">
                <dl className="meta-grid">
                  <div>
                    <dt>Type</dt>
                    <dd>{selectedAgent.agentType}</dd>
                  </div>
                  <div>
                    <dt>Cron</dt>
                    <dd>
                      <code>{selectedAgent.cronExpression || "manual only"}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>
                      {selectedAgent.archivedAt ? "Archived" : selectedAgent.enabled ? "Enabled" : "Disabled"}
                    </dd>
                  </div>
                  <div>
                    <dt>Executor</dt>
                    <dd>{selectedAgent.executorStatus}</dd>
                  </div>
                  <div>
                    <dt>Active executions</dt>
                    <dd>{selectedAgent.activeExecutionCount}</dd>
                  </div>
                  <div>
                    <dt>Last heartbeat</dt>
                    <dd>{formatTime(selectedAgent.lastHeartbeatAt)}</dd>
                  </div>
                  {selectedAgent.archivedAt ? (
                    <div>
                      <dt>Archived at</dt>
                      <dd>{formatTime(selectedAgent.archivedAt)}</dd>
                    </div>
                  ) : null}
                </dl>

                {!selectedAgent.archivedAt ? (
                  <>
                    <div className="action-group" style={{ marginTop: 18 }}>
                      <button
                        className="ghost-button"
                        onClick={() =>
                          handleToggleAgent(selectedAgent.id, !selectedAgent.enabled)
                        }
                      >
                        {selectedAgent.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="ghost-button"
                        disabled={drainBusyAgentId === selectedAgent.id}
                        onClick={() => handleDrainAgent(selectedAgent)}
                      >
                        {drainBusyAgentId === selectedAgent.id ? "Draining..." : "Drain"}
                      </button>
                      <button
                        className="action-button action-button--cancel"
                        disabled={deleteBusyAgentId === selectedAgent.id}
                        onClick={() => handleDeleteAgent(selectedAgent)}
                      >
                        {deleteBusyAgentId === selectedAgent.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>

                    <div className="agent-runtime-grid">
                      <AgentTriggerPanel
                        payloadText={triggerPayloadText}
                        busy={triggerBusyAgentId === selectedAgent.id}
                        error={triggerError}
                        onPayloadChange={(value) => {
                          setTriggerPayloadText(value);
                          if (triggerError) setTriggerError(null);
                        }}
                        onSubmit={() => handleSubmitAgentTrigger(selectedAgent)}
                      />

                      <section className="agent-runtime-section">
                        <header>
                          <span className="agent-runtime-section__icon">
                            <Icon name="timer" />
                          </span>
                          <div>
                            <h3>Upcoming Schedule</h3>
                            <p>{selectedAgent.cronExpression || "Manual trigger only"}</p>
                          </div>
                        </header>
                        {selectedAgent.cronExpression ? (
                          schedulePreviewLoading ? (
                            <div className="schedule-preview__loading">Loading upcoming runs...</div>
                          ) : schedulePreview.length > 0 ? (
                            <ol className="schedule-preview-list">
                              {schedulePreview.map((runAt, index) => (
                                <li key={runAt}>
                                  <span>Run {index + 1}</span>
                                  <time dateTime={runAt}>{formatTime(runAt)}</time>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <p className="muted-text">No upcoming runs returned by the scheduler.</p>
                          )
                        ) : (
                          <p className="muted-text">This agent runs only when triggered manually or through the API.</p>
                        )}
                      </section>

                      <AgentSettingsPanel
                        values={agentSettingsForm}
                        busy={agentSettingsBusy}
                        error={agentSettingsError}
                        onChange={(patch) => {
                          setAgentSettingsForm((current) => ({ ...current, ...patch }));
                          if (agentSettingsError) setAgentSettingsError(null);
                        }}
                        onSubmit={() => handleSaveAgentSettings(selectedAgent)}
                      />
                    </div>
                  </>
                ) : null}

                <dl className="agent-identity-strip">
                  <div>
                    <dt>Handler</dt>
                    <dd>{selectedAgent.handlerName || "-"}</dd>
                  </div>
                  <div>
                    <dt>Executor host</dt>
                    <dd>{selectedAgent.executorHost || "-"}</dd>
                  </div>
                  <div>
                    <dt>Idempotency window</dt>
                    <dd>{formatSeconds(selectedAgent.idempotencyWindowSeconds)}</dd>
                  </div>
                </dl>
              </div>

              {/* Recent Executions for this agent */}
              <div className="panel">
                <header className="panel__header">
                  <div>
                    <h2>Recent Executions</h2>
                    <p>
                      Last runs for {agentDisplayName(selectedAgent)}.
                    </p>
                  </div>
                </header>

                <ExecutionTable
                  executions={(selectedAgent.recentExecutions ?? executions.filter((e) => e.agentId === selectedAgent.id))
                    .slice(0, 20)}
                  agents={allKnownAgents}
                  onSelect={openDetail}
                  onCancel={handleCancelExecution}
                  onRerun={handleRerunExecution}
                  actionBusyExecutionId={actionBusyExecutionId}
                />
              </div>
            </>
          )}
        </main>
      </div>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="app-footer">
        <span>
          Agent Cron Hub &middot;{" "}
          {lastSyncedAt
            ? `Last sync ${new Date(lastSyncedAt).toLocaleTimeString()}`
            : "Loading…"}
        </span>
        <span>Dashboard auth</span>
      </footer>
    </div>
  );
}
