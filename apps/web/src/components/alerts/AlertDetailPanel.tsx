import type { AlertEntry } from "../../lib/types.js";

interface AlertDetailPanelProps {
  alert: AlertEntry;
  onAcknowledge: (id: number) => void;
  onClose: () => void;
}

export function AlertDetailPanel({ alert, onAcknowledge, onClose }: AlertDetailPanelProps) {
  const severity = alert.severity ?? "info";
  const isAcked = !!(alert.acknowledgedAt ?? alert.acknowledged_at);
  const context = alert.context as Record<string, unknown> | undefined;

  return (
    <div className="alert-detail-panel">
      <div className="alert-detail-panel__header">
        <span className={`status-pill status-pill--${severity === "critical" ? "danger" : severity === "warning" ? "warning" : "info"}`}>
          {severity}
        </span>
        <span className="alert-detail-panel__rule">{alert.ruleName ?? alert.rule_name}</span>
        <button onClick={onClose} className="ghost-button" style={{ marginLeft: "auto" }}>x</button>
      </div>
      <div className="alert-detail-panel__body">
        <div className="alert-detail-panel__field">
          <strong>Message:</strong>
          <p>{alert.message}</p>
        </div>
        <div className="alert-detail-panel__field">
          <strong>Agent:</strong> {alert.agentDisplayName ?? alert.agentName ?? "—"}
        </div>
        <div className="alert-detail-panel__field">
          <strong>Created:</strong> {alert.createdAt ?? alert.created_at ?? "—"}
        </div>
        {isAcked ? (
          <div className="alert-detail-panel__field">
            <strong>Acknowledged by:</strong> {alert.acknowledgedBy ?? alert.acknowledged_by ?? "—"}
            {" at "}{alert.acknowledgedAt ?? alert.acknowledged_at}
          </div>
        ) : (
          <div className="alert-detail-panel__actions">
            <button onClick={() => onAcknowledge(alert.id)} className="action-button action-button--approve">
              Acknowledge
            </button>
          </div>
        )}
        {context ? (
          <div className="alert-detail-panel__field">
            <strong>Context:</strong>
            <pre style={{ fontSize: "0.75rem", background: "rgba(0,0,0,0.3)", padding: "0.5rem", borderRadius: 8, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(context, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
