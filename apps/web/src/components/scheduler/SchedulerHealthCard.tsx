import type { SchedulerRuntimeStats } from "../../lib/types.js";

interface SchedulerHealthCardProps {
  stats: SchedulerRuntimeStats | null;
}

export function SchedulerHealthCard({ stats }: SchedulerHealthCardProps) {
  if (!stats) return <div className="panel"><p style={{ padding: "1rem" }}>No scheduler data available.</p></div>;

  const running = stats.running;
  const tickCount = stats.tick_count ?? stats.tickCount ?? 0;
  const overlapSkips = stats.overlap_skipped_count ?? stats.overlapSkippedCount ?? 0;
  const lockSkips = stats.lock_skipped_count ?? stats.lockSkippedCount ?? 0;
  const lastTickMs = stats.last_tick_duration_ms ?? stats.lastTickDurationMs ?? 0;
  const tickErrors = stats.last_tick_error_count ?? stats.lastTickErrorCount ?? 0;
  const stepErrors = stats.last_tick_step_errors ?? stats.lastTickStepErrors ?? [];

  return (
    <div className="panel" style={{ marginBottom: "1.5rem" }}>
      <div className="panel__header">
        <h3>Scheduler Health</h3>
        <span className={`status-pill status-pill--${running ? "success" : "danger"}`}>
          {running ? "● Running" : "○ Stopped"}
        </span>
      </div>
      <div className="scheduler-health-grid">
        <div className="scheduler-health-card">
          <span className="scheduler-health-card__label">Tick Count</span>
          <span className="scheduler-health-card__value">{tickCount.toLocaleString()}</span>
        </div>
        <div className="scheduler-health-card">
          <span className="scheduler-health-card__label">Last Tick</span>
          <span className="scheduler-health-card__value">{lastTickMs}ms</span>
        </div>
        <div className="scheduler-health-card">
          <span className="scheduler-health-card__label">Overlap Skips</span>
          <span className="scheduler-health-card__value" style={{ color: overlapSkips > 0 ? "#fca5a5" : undefined }}>{overlapSkips}</span>
        </div>
        <div className="scheduler-health-card">
          <span className="scheduler-health-card__label">Lock Skips</span>
          <span className="scheduler-health-card__value" style={{ color: lockSkips > 0 ? "#fca5a5" : undefined }}>{lockSkips}</span>
        </div>
        <div className="scheduler-health-card">
          <span className="scheduler-health-card__label">Tick Errors</span>
          <span className="scheduler-health-card__value" style={{ color: tickErrors > 0 ? "#fca5a5" : "#86efac" }}>{tickErrors}</span>
        </div>
      </div>
      {stepErrors.length > 0 ? (
        <div style={{ padding: "0.5rem 1rem", fontSize: "0.82rem" }}>
          <strong style={{ color: "#fca5a5" }}>Step Errors:</strong>
          {stepErrors.map((e: any, i: number) => (
            <div key={i} style={{ color: "#fca5a5", marginTop: "0.25rem" }}>
              {e.step}: {e.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
