import { useState, useEffect } from "react";
import type { SchedulerAgentStatus } from "../../lib/types.js";
import { authHeaders } from "../../lib/auth.js";

interface CronOverviewProps {
  agents: SchedulerAgentStatus[];
}

export function CronOverview({ agents }: CronOverviewProps) {
  const cronAgents = agents.filter(a => a.cronExpression);

  if (!cronAgents.length) {
    return <div className="panel"><p style={{ padding: "1rem", color: "#94a3b8" }}>No cron agents configured.</p></div>;
  }

  return (
    <div className="panel">
      <div className="panel__header">
        <h3>Cron Agents ({cronAgents.length})</h3>
      </div>
      <div className="cron-overview-list">
        {cronAgents.map(agent => (
          <CronAgentRow key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function CronAgentRow({ agent }: { agent: SchedulerAgentStatus }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<string[]>([]);

  useEffect(() => {
    if (expanded && !preview.length) {
      fetch(`/api/agents/${agent.id}/schedule-preview?limit=5`, { headers: authHeaders() })
        .then(r => r.json())
        .then(d => setPreview(d.runs ?? []))
        .catch(() => {});
    }
  }, [expanded, agent.id]);

  const scheduleTone = agent.scheduleState === "due" ? "warning"
    : agent.scheduleState === "queue_full" ? "danger"
    : agent.scheduleState === "disabled" ? "neutral"
    : agent.scheduleState === "manual_only" ? "neutral"
    : "success";

  return (
    <div className="cron-agent-row">
      <div className="cron-agent-row__header" onClick={() => setExpanded(!expanded)}>
        <span className="cron-agent-row__toggle">{expanded ? "▼" : "▶"}</span>
        <strong className="cron-agent-row__name">{agent.displayName}</strong>
        <code className="cron-agent-row__expr">{agent.cronExpression}</code>
        <span className={`status-pill status-pill--${scheduleTone}`} style={{ fontSize: "0.72rem" }}>
          {agent.scheduleState}
        </span>
        {agent.nextRunAt ? (
          <span className="cron-agent-row__next" style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
            Next: {new Date(agent.nextRunAt).toLocaleTimeString()}
          </span>
        ) : null}
        {agent.misfirePolicy && agent.misfirePolicy !== "fire_once" ? (
          <span className="cron-agent-row__misfire" style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem", borderRadius: 6, background: agent.misfirePolicy === "fire_all" ? "rgba(245,158,11,0.2)" : "rgba(148,163,184,0.2)", color: agent.misfirePolicy === "fire_all" ? "#fcd34d" : "#94a3b8" }}>
            {agent.misfirePolicy}
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div className="cron-agent-row__body">
          <div className="cron-agent-row__detail">
            <div>
              <strong>Schedule State:</strong> {agent.scheduleState}
            </div>
            <div>
              <strong>Dispatch State:</strong> {agent.dispatchState}
            </div>
            <div>
              <strong>Queue:</strong> {agent.queuedCount} / {agent.maxPendingQueue}
            </div>
            <div>
              <strong>Running:</strong> {agent.runningCount} / {agent.concurrency}
            </div>
          </div>
          {preview.length > 0 ? (
            <div className="cron-agent-row__preview">
              <strong>Upcoming Schedule:</strong>
              <ol style={{ margin: "0.25rem 0 0 1.2rem", fontSize: "0.82rem", color: "#94a3b8" }}>
                {preview.map((t, i) => (
                  <li key={i}>{new Date(t).toLocaleString()}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
