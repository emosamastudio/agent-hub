import { useState } from "react";
import type { AlertEntry } from "../lib/types.js";
import { AlertFilterBar } from "../components/alerts/AlertFilterBar.js";
import { AlertDetailPanel } from "../components/alerts/AlertDetailPanel.js";
import { acknowledgeAlert } from "../lib/api.js";

interface AlertsPageProps {
  alerts: AlertEntry[];
  onRefresh: () => void;
}

export function AlertsPage({ alerts, onRefresh }: AlertsPageProps) {
  const [severity, setSeverity] = useState("");
  const [acknowledged, setAcknowledged] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  let filtered = alerts;
  if (severity) filtered = filtered.filter(a => (a.severity ?? "") === severity);
  if (acknowledged === "unacknowledged") filtered = filtered.filter(a => !(a.acknowledgedAt ?? a.acknowledged_at));
  if (acknowledged === "acknowledged") filtered = filtered.filter(a => !!(a.acknowledgedAt ?? a.acknowledged_at));

  const counts = {
    total: alerts.length,
    critical: alerts.filter(a => a.severity === "critical").length,
    warning: alerts.filter(a => a.severity === "warning").length,
    active: alerts.filter(a => !(a.acknowledgedAt ?? a.acknowledged_at)).length,
  };

  const selectedAlert = selectedId ? alerts.find(a => a.id === selectedId) : null;

  const handleAcknowledge = async (id: number) => {
    try { await acknowledgeAlert(id); onRefresh(); } catch {}
  };

  return (
    <div>
      <div className="page-context-bar">
        <span className="page-context-bar__eyebrow">Alerts</span>
        {counts.active > 0 ? <span className="badge badge--danger">{counts.active} active</span> : null}
      </div>

      <div className="summary-grid" style={{ marginBottom: "1.5rem" }}>
        <div className="stat-card stat-card--neutral">
          <span className="stat-card__label">Total</span>
          <span className="stat-card__value">{counts.total}</span>
        </div>
        <div className="stat-card stat-card--danger">
          <span className="stat-card__label">Critical</span>
          <span className="stat-card__value">{counts.critical}</span>
        </div>
        <div className="stat-card stat-card--warning">
          <span className="stat-card__label">Warning</span>
          <span className="stat-card__value">{counts.warning}</span>
        </div>
        <div className="stat-card stat-card--info">
          <span className="stat-card__label">Active</span>
          <span className="stat-card__value">{counts.active}</span>
        </div>
      </div>

      <AlertFilterBar severity={severity} acknowledged={acknowledged} onChange={(patch) => { if (patch.severity !== undefined) setSeverity(patch.severity); if (patch.acknowledged !== undefined) setAcknowledged(patch.acknowledged); }} />

      <div className={selectedAlert ? "operations-workspace" : ""}>
        <div className="operations-workspace__list">
          <div className="panel">
            {filtered.length === 0 ? (
              <p style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>No alerts match the current filters.</p>
            ) : (
              <table className="runs-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Rule</th>
                    <th>Agent</th>
                    <th>Message</th>
                    <th>Time</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(alert => {
                    const isAcked = !!(alert.acknowledgedAt ?? alert.acknowledged_at);
                    const sev = alert.severity ?? "info";
                    return (
                      <tr key={alert.id} onClick={() => setSelectedId(alert.id)} style={{ cursor: "pointer", background: selectedId === alert.id ? "rgba(59,130,246,0.08)" : undefined }}>
                        <td><span className={`status-pill status-pill--${sev === "critical" ? "danger" : sev === "warning" ? "warning" : "info"}`} style={{ padding: "0.1rem 0.5rem" }}>{sev}</span></td>
                        <td style={{ fontSize: "0.82rem" }}>{alert.ruleName ?? alert.rule_name ?? "—"}</td>
                        <td style={{ fontSize: "0.82rem" }}>{alert.agentDisplayName ?? alert.agentName ?? "—"}</td>
                        <td style={{ fontSize: "0.8rem", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{alert.message ?? "—"}</td>
                        <td style={{ fontSize: "0.78rem", color: "#94a3b8" }}>{alert.createdAt ? new Date(alert.createdAt).toLocaleString() : alert.created_at ? new Date(alert.created_at).toLocaleString() : "—"}</td>
                        <td>{isAcked ? <span style={{ color: "#64748b", fontSize: "0.78rem" }}>Acked</span> : <span style={{ color: "#fca5a5", fontSize: "0.78rem" }}>Active</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        {selectedAlert ? (
          <div className="operations-workspace__inspector">
            <AlertDetailPanel alert={selectedAlert} onAcknowledge={handleAcknowledge} onClose={() => setSelectedId(null)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
