import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchAgents,
  fetchExecutions,
  fetchStats,
  fetchTraces,
  patchAgent,
  triggerAgent,
  connectSocket,
} from "./lib/api";
import "./App.css";

/* ── Types ─────────────────────────────────────────────────────── */

type SocketStatus = "connecting" | "open" | "reconnecting" | "error";
type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";
type Page = "overview" | "agents" | "executions" | "detail" | "agent-detail";

interface PageDefinition {
  id: Page;
  label: string;
  description: string;
  badge?: string;
}

interface Agent {
  id: string;
  name: string;
  displayName: string;
  agentType: string;
  cronExpression: string | null;
  enabled: boolean;
  executorStatus: string;
  activeExecutionCount: number;
  lastExecutionAt: string | null;
  lastHeartbeatAt: string | null;
  recentExecutions?: Execution[];
}

interface Execution {
  id: string;
  agentId: string;
  triggerType: string;
  status: string;
  triggeredBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  errorMessage: string | null;
  traceCountActual: number;
}

/* ── Helpers ──────────────────────────────────────────────────── */

function statusColor(s: string) {
  switch (s) {
    case "success":
      return "🟢";
    case "failed":
    case "timeout":
    case "error":
      return "🔴";
    case "running":
      return "🔵";
    case "queued":
    case "pending":
      return "🟡";
    default:
      return "⚪";
  }
}

function cronDot(s: string) {
  switch (s) {
    case "success":
      return "🟢";
    case "failed":
    case "timeout":
    case "error":
      return "🔴";
    default:
      return "⚪";
  }
}

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

function agentDisplayName(a: Agent): string {
  return a.displayName || a.name || (a.id ? a.id.slice(0, 8) : "?");
}

function projectName(a: Agent): string {
  return (a.name || "").split("_")[0] || "-";
}

/* ── Sub-components ───────────────────────────────────────────── */

function StatusPill({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <span className={`status-pill status-pill--${tone}`}>{children}</span>
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
      <span className="page-nav__label">{pageDef.label}</span>
      {pageDef.badge ? (
        <span className="page-nav__badge">{pageDef.badge}</span>
      ) : null}
    </button>
  );

  return (
    <nav className="page-nav" aria-label="Page navigation">
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
    </nav>
  );
}

/* ── Execution Table ──────────────────────────────────────────── */

function ExecutionTable({
  executions,
  agents,
  onSelect,
}: {
  executions: Execution[];
  agents: Agent[];
  onSelect: (e: Execution) => void;
}) {
  const agentName = (agentId: string) => {
    const a = agents.find((x) => x.id === agentId);
    return a ? agentDisplayName(a) : agentId.slice(0, 8);
  };

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
          </tr>
        </thead>
        <tbody>
          {executions.map((e) => (
            <tr
              key={e.id}
              onClick={() => onSelect(e)}
              style={{ cursor: "pointer" }}
            >
              <td>{formatTime(e.startedAt)}</td>
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
            </tr>
          ))}
        </tbody>
      </table>
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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [stats, setStats] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  /* detail pages */
  const [selectedExecution, setSelectedExecution] =
    useState<Execution | null>(null);
  const [traces, setTraces] = useState<any[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  /* websocket */
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("connecting");

  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

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
      const [a, e, s] = await Promise.all([
        fetchAgents(),
        fetchExecutions({ limit: "50" }),
        fetchStats(),
      ]);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setAgents(Array.isArray(a) ? a : []);
      setExecutions(Array.isArray(e) ? e : []);
      setStats(s || {});
      setLastSyncedAt(new Date().toISOString());
    } catch (err: any) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setError(err?.message ?? "Failed to load data");
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
        ws.onclose = null;
        ws.close();
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
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* actions */
  const handleToggleAgent = async (agentId: string, enabled: boolean) => {
    await patchAgent(agentId, { enabled });
    loadData(true);
  };

  const handleTriggerAgent = async (name: string) => {
    await triggerAgent(name, {});
    loadData(true);
  };

  /* detail navigation */
  const openDetail = async (e: Execution) => {
    setSelectedExecution(e);
    setTraces([]);
    setPage("detail");
    try {
      const t = await fetchTraces(e.id);
      setTraces(Array.isArray(t) ? t : []);
    } catch {
      setTraces([]);
    }
  };

  const openAgentDetail = (a: Agent) => {
    setSelectedAgent(a);
    setPage("agent-detail");
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

  const runningCount = executions.filter(
    (e) => e.status === "running",
  ).length;

  const recentFailures =
    stats.recentFailures ?? executions.filter(
      (e) =>
        e.status === "failed" ||
        e.status === "timeout" ||
        e.status === "error",
    ).length;

  /* render */
  return (
    <div className="dashboard-shell">
      {/* ── Header ────────────────────────────────────────── */}
      <header className="app-header app-header--compact">
        <div className="app-header__copy">
          <span className="eyebrow">Local-first control plane</span>
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
            Refresh snapshot
          </button>
        </div>
      </header>

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
              setPage(p);
            }}
          />
        </aside>

        <main className="workspace-main">
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

              {/* Page context bar */}
              <div className="page-context-bar">
                <div>
                  <span className="page-context-bar__eyebrow">Snapshot</span>
                  <h2>Recent Executions</h2>
                  <p>Latest runs across all agents. Click a row for full trace details.</p>
                </div>
              </div>

              <div className="panel">
                <ExecutionTable
                  executions={executions.slice(0, 10)}
                  agents={agents}
                  onSelect={openDetail}
                />
              </div>
            </>
          )}

          {/* ═══ AGENTS ═══ */}
          {!loading && page === "agents" && (
            <>
              <div className="page-context-bar">
                <div>
                  <span className="page-context-bar__eyebrow">Directory</span>
                  <h2>Agents</h2>
                  <p>
                    Each agent has a cron expression, online/offline status, and recent execution
                    dots. Click an agent row to inspect details.
                  </p>
                </div>
              </div>

              <div className="panel">
                {agents.length === 0 ? (
                  <div className="empty-state">
                    <h3>No agents registered</h3>
                    <p>Agents will appear here once they connect or are configured.</p>
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
                          <th>Last 10</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agents.map((a) => (
                          <tr
                            key={a.id}
                            onClick={() => openAgentDetail(a)}
                            style={{ cursor: "pointer" }}
                          >
                            <td>{projectName(a)}</td>
                            <td>
                              <div className="table-primary">
                                <strong>{agentDisplayName(a)}</strong>
                              </div>
                            </td>
                            <td>
                              <code>{a.cronExpression || "manual"}</code>
                            </td>
                            <td>
                              <StatusPill
                                tone={
                                  a.enabled
                                    ? a.executorStatus === "online"
                                      ? "success"
                                      : "warning"
                                    : "neutral"
                                }
                              >
                                {a.enabled
                                  ? a.executorStatus === "online"
                                    ? "on"
                                    : "offline"
                                  : "off"}
                              </StatusPill>
                            </td>
                            <td>
                              {(a.recentExecutions ?? [])
                                .slice(0, 10)
                                .map((e, i) => (
                                  <span key={i} title={e.status}>
                                    {cronDot(e.status)}
                                  </span>
                                ))}
                            </td>
                            <td>
                              <div className="action-group">
                                <button
                                  className="ghost-button ghost-button--compact"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    handleToggleAgent(a.id, !a.enabled);
                                  }}
                                >
                                  {a.enabled ? "Disable" : "Enable"}
                                </button>
                                <button
                                  className="action-button action-button--resume"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    handleTriggerAgent(a.name);
                                  }}
                                >
                                  Run
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
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

              <div className="panel">
                <ExecutionTable
                  executions={executions}
                  agents={agents}
                  onSelect={openDetail}
                />
              </div>
            </>
          )}

          {/* ═══ DETAIL (Trace Viewer) ═══ */}
          {!loading && page === "detail" && selectedExecution && (
            <>
              <div className="page-context-bar">
                <div>
                  <button
                    className="ghost-button ghost-button--compact"
                    style={{ marginBottom: 8 }}
                    onClick={() => setPage("executions")}
                  >
                    &larr; Back to Executions
                  </button>
                  <h2>Execution Detail</h2>
                  <p>
                    Status, timing, and trace spans for this execution.
                  </p>
                </div>
                <StatusPill tone={getStatusTone(selectedExecution.status)}>
                  {selectedExecution.status}
                </StatusPill>
              </div>

              <div className="panel">
                <dl className="meta-grid">
                  <div>
                    <dt>Status</dt>
                    <dd>
                      {statusColor(selectedExecution.status)}{" "}
                      {selectedExecution.status}
                    </dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>
                      {selectedExecution.durationMs
                        ? `${selectedExecution.durationMs}ms`
                        : "N/A"}
                    </dd>
                  </div>
                  <div>
                    <dt>Trigger</dt>
                    <dd>
                      {selectedExecution.triggerType} &mdash;{" "}
                      {selectedExecution.triggeredBy ?? "-"}
                    </dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{formatTime(selectedExecution.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>Traces recorded</dt>
                    <dd>{selectedExecution.traceCountActual ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Agent ID</dt>
                    <dd className="truncate-path">{selectedExecution.agentId}</dd>
                  </div>
                </dl>

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
              </div>

              {/* Traces */}
              <div className="panel">
                <header className="panel__header">
                  <div>
                    <h2>Traces</h2>
                    <p>Span-level details captured during this execution.</p>
                  </div>
                </header>

                {!Array.isArray(traces) || traces.length === 0 ? (
                  <div className="empty-state">
                    <h3>No traces recorded</h3>
                    <p>
                      This execution did not produce any trace spans.
                    </p>
                  </div>
                ) : (
                  <ul className="timeline-list">
                    {traces.map((t: any, i: number) => (
                      <li key={i} className="timeline-item">
                        <div
                          className={`event-dot event-dot--${getStatusTone(
                            t.status ?? "neutral",
                          )}`}
                        />
                        <div className="timeline-item__body">
                          <p>
                            <strong>
                              Turn {t.turn_index}.{t.span_index}
                            </strong>{" "}
                            &mdash; {t.span_type} ({t.role})
                            {t.model ? ` &mdash; ${t.model}` : ""}
                            {t.latency_ms
                              ? ` &mdash; ${t.latency_ms}ms`
                              : ""}
                          </p>
                          {t.input_content ? (
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
                                {t.input_content.slice(0, 2000)}
                              </pre>
                            </details>
                          ) : null}
                          {t.output_content ? (
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
                                {t.output_content.slice(0, 2000)}
                              </pre>
                            </details>
                          ) : null}
                          <div className="timeline-item__meta">
                            {t.input_tokens != null
                              ? `${t.input_tokens} in`
                              : ""}
                            {t.output_tokens != null
                              ? ` / ${t.output_tokens} out`
                              : ""}
                          </div>
                        </div>
                      </li>
                    ))}
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
                  tone={
                    selectedAgent.enabled
                      ? selectedAgent.executorStatus === "online"
                        ? "success"
                        : "warning"
                      : "neutral"
                  }
                >
                  {selectedAgent.enabled
                    ? selectedAgent.executorStatus === "online"
                      ? "online"
                      : "offline"
                    : "disabled"}
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
                      {selectedAgent.enabled ? "Enabled" : "Disabled"}
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
                </dl>

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
                    className="action-button action-button--resume"
                    onClick={() => handleTriggerAgent(selectedAgent.name)}
                  >
                    Trigger Now
                  </button>
                </div>
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
                  executions={executions
                    .filter(
                      (e) =>
                        agents.find((a) => a.id === e.agentId)?.name ===
                        selectedAgent.name,
                    )
                    .slice(0, 20)}
                  agents={agents}
                  onSelect={openDetail}
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
        <span>Basic auth &middot; admin:admin</span>
      </footer>
    </div>
  );
}
