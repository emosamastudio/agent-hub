import { useState, useEffect, useCallback } from "react";
import { fetchAgents, fetchExecutions, fetchStats, patchAgent, triggerAgent, connectSocket } from "./lib/api";

type Page = "overview" | "agents" | "executions" | "detail" | "agent-detail";

interface Agent {
  id: string; name: string; display_name: string; agent_type: string;
  cron_expression: string | null; enabled: boolean;
  executor_status: string; active_execution_count: number;
  last_execution_at: string | null; last_heartbeat_at: string | null;
  recentExecutions?: Execution[];
}

interface Execution {
  id: string; agent_id: string; trigger_type: string; status: string;
  triggered_by: string | null;
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
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const loadData = useCallback(async () => {
    const [a, e, s] = await Promise.all([fetchAgents(), fetchExecutions({ limit: "50" }), fetchStats()]);
    setAgents(Array.isArray(a) ? a : []);
    setExecutions(Array.isArray(e) ? e : []);
    setStats(s || {});
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const ws = connectSocket();
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = () => loadData();
    return () => ws.close();
  }, [loadData]);

  useEffect(() => {
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const statusColor = (s: string) => {
    switch (s) { case "success": return "🟢"; case "failed": case "timeout": return "🔴"; case "running": return "🔵"; case "queued": return "🟡"; default: return "⚪"; }
  };

  const cronDot = (s: string) => {
    switch (s) { case "success": return "🟢"; case "failed": case "timeout": return "🔴"; default: return "⚪"; }
  };

  const openDetail = (e: Execution) => {
    setSelectedExecution(e);
    setPage("detail");
    fetch(`/api/executions/${e.id}/traces`, { headers: { "Authorization": "Basic " + btoa("admin:admin") } })
      .then(r => r.json()).then(setTraces);
  };

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: "1200px", margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h1 style={{ margin: 0 }}>Agent Cron Hub</h1>
        <span style={{ fontSize: "0.85rem", color: wsConnected ? "green" : "red" }}>{wsConnected ? "● Live" : "○ Disconnected"}</span>
      </header>

      <nav style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", borderBottom: "1px solid #ddd", paddingBottom: "0.5rem" }}>
        {(["overview", "agents", "executions"] as Page[]).map(p => (
          <button key={p} onClick={() => setPage(p)}
            style={{ background: page === p ? "#333" : "transparent", color: page === p ? "#fff" : "#333", border: "none", padding: "0.5rem 1rem", borderRadius: "4px", cursor: "pointer", textTransform: "capitalize" }}>
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
          <ExecutionTable executions={executions.slice(0, 10)} agents={agents} onSelect={openDetail} statusColor={statusColor} />
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
                <tr key={a.id} onClick={() => { setSelectedAgent(a); setPage("agent-detail"); }}
                  style={{ borderBottom: "1px solid #eee", cursor: "pointer" }}>
                  <td style={{ padding: "0.5rem" }}>{(a.name || "").split("_")[0] ?? "-"}</td>
                  <td style={{ padding: "0.5rem", fontWeight: 500 }}>{a.display_name || a.name}</td>
                  <td style={{ padding: "0.5rem", fontFamily: "monospace", fontSize: "0.85rem" }}>{a.cron_expression || "manual"}</td>
                  <td style={{ padding: "0.5rem" }}>
                    <span style={{ color: a.enabled ? (a.executor_status === "online" ? "green" : "orange") : "gray" }}>
                      {a.enabled ? (a.executor_status === "online" ? "● on" : "○ offline") : "◌ off"}
                    </span>
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    {(a.recentExecutions ?? []).slice(0, 10).map((e, i) => (
                      <span key={i} title={e.status}>{cronDot(e.status)}</span>
                    ))}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    <button onClick={() => patchAgent(a.id, { enabled: !a.enabled }).then(loadData)} style={{ marginRight: "0.25rem" }}>{a.enabled ? "Disable" : "Enable"}</button>
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
          <ExecutionTable executions={executions} agents={agents} onSelect={openDetail} statusColor={statusColor} />
        </div>
      )}

      {page === "detail" && selectedExecution && (
        <div>
          <button onClick={() => setPage("executions")} style={{ marginBottom: "1rem" }}>← Back</button>
          <h2>Execution Detail</h2>
          <div style={{ background: "#f5f5f5", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
            <p>Status: {statusColor(selectedExecution.status)} {selectedExecution.status}</p>
            <p>Duration: {selectedExecution.duration_ms ? `${selectedExecution.duration_ms}ms` : "N/A"}</p>
            <p>Trigger: {selectedExecution.trigger_type} — {selectedExecution.triggered_by ?? "-"}</p>
            {selectedExecution.error_message && <p style={{ color: "red" }}>Error: {selectedExecution.error_message}</p>}
            {selectedExecution.result_summary && <p>Result: {selectedExecution.result_summary}</p>}
            <p>Traces: {selectedExecution.trace_count_actual ?? 0} recorded</p>
          </div>
          <h3>Traces</h3>
          {(!Array.isArray(traces) || traces.length === 0) && <p>No traces recorded.</p>}
          {Array.isArray(traces) && traces.map((t: any, i: number) => (
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

      {page === "agent-detail" && selectedAgent && (
        <div>
          <button onClick={() => setPage("agents")} style={{ marginBottom: "1rem" }}>&larr; Back</button>
          <h2>{selectedAgent.display_name || selectedAgent.name}</h2>
          <div style={{ background: "#f5f5f5", padding: "1rem", borderRadius: "8px", margin: "1rem 0" }}>
            <p>Type: {selectedAgent.agent_type}</p>
            <p>Cron: {selectedAgent.cron_expression || "manual only"}</p>
            <p>Status: {selectedAgent.enabled ? "enabled" : "disabled"}</p>
            <p>Executor: {selectedAgent.executor_status}</p>
            <p>Active executions: {selectedAgent.active_execution_count}</p>
            <div style={{ marginTop: "1rem" }}>
              <button onClick={() => patchAgent(selectedAgent.id, { enabled: !selectedAgent.enabled }).then(loadData)}
                style={{ marginRight: "0.5rem" }}>
                {selectedAgent.enabled ? "Disable" : "Enable"}
              </button>
              <button onClick={() => triggerAgent(selectedAgent.name, {}).then(loadData)}>
                Trigger Now
              </button>
            </div>
          </div>
          <h3>Recent Executions</h3>
          <ExecutionTable
            executions={executions.filter(e => agents.find(a => a.id === e.agent_id)?.name === selectedAgent.name).slice(0, 20)}
            agents={agents}
            onSelect={openDetail} statusColor={statusColor} />
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

function ExecutionTable({ executions, agents, onSelect, statusColor }: {
  executions: Execution[];
  agents: Agent[];
  onSelect: (e: Execution) => void;
  statusColor: (s: string) => string;
}) {
  const agentName = (agentId: string) => agents.find(a => a.id === agentId)?.display_name || agentId.slice(0, 8);
  if (!Array.isArray(executions) || executions.length === 0) return <p>No executions yet.</p>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
          <th>Time</th><th>Agent</th><th>Status</th><th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {executions.map(e => (
          <tr key={e.id} onClick={() => onSelect(e)} style={{ borderBottom: "1px solid #eee", cursor: "pointer" }}>
            <td style={{ padding: "0.5rem" }}>{e.started_at ? new Date(e.started_at).toLocaleTimeString() : "-"}</td>
            <td style={{ padding: "0.5rem" }}>{agentName(e.agent_id)} &mdash; {e.trigger_type}</td>
            <td style={{ padding: "0.5rem" }}>{statusColor(e.status)} {e.status}</td>
            <td style={{ padding: "0.5rem" }}>{e.duration_ms ? `${e.duration_ms}ms` : "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
