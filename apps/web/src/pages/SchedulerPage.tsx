import type { SchedulerRuntimeStats, SchedulerAgentStatus } from "../lib/types.js";
import { SchedulerHealthCard } from "../components/scheduler/SchedulerHealthCard.js";
import { CronOverview } from "../components/scheduler/CronOverview.js";

interface SchedulerPageProps {
  schedulerStatus: { scheduler?: any; agents?: SchedulerAgentStatus[] } | null;
  schedulerRuntimeStats: SchedulerRuntimeStats | null;
}

export function SchedulerPage({ schedulerStatus, schedulerRuntimeStats }: SchedulerPageProps) {
  return (
    <div>
      <div className="page-context-bar">
        <span className="page-context-bar__eyebrow">Scheduler</span>
      </div>
      <p style={{ color: "#94a3b8", fontSize: "0.9rem", marginTop: 0 }}>
        Monitor cron scheduling, tick health, and agent schedules.
      </p>

      <SchedulerHealthCard stats={schedulerRuntimeStats} />
      <CronOverview agents={schedulerStatus?.agents ?? []} />
    </div>
  );
}
