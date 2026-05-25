import type { Agent, Execution, SchedulerAgentStatus } from "../../lib/types.js";

interface AgentHealthGridProps {
  agents: Agent[];
  executions: Execution[];
  schedulerStatus: { scheduler?: { tickMs: number }; agents?: SchedulerAgentStatus[] } | null;
  /** Map project ID → display color stripe. Defaults cycle through palette. */
  projectColors?: Record<string, string>;
  onOpenAgent: (agent: Agent) => void;
}

const TYPE_ICON: Record<string, string> = {
  llm_agent: "🧠",
  cron_task: "⚙️",
};

const PROJECT_PALETTE = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#a855f7", // purple
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

type AgentTileData = {
  agent: Agent;
  projectColor: string;
  status: "online" | "degraded" | "offline" | "disabled" | "archived";
  statusLabel: string;
  last5Dots: Array<"success" | "failed" | "timeout" | "running" | "queued" | "">;
  runningCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  recentFailures: number;
};

const DOT_TONES: Record<string, string> = {
  success: "success",
  failed: "danger",
  timeout: "warning",
  running: "info",
  queued: "neutral",
};

export function AgentHealthGrid({ agents, executions, schedulerStatus, projectColors, onOpenAgent }: AgentHealthGridProps) {
  const projectColorMap: Record<string, string> = {};
  const seenProjects = new Set<string>();
  for (const a of agents) {
    if (!seenProjects.has(a.projectId)) {
      seenProjects.add(a.projectId);
      projectColorMap[a.projectId] = projectColors?.[a.projectId] ?? PROJECT_PALETTE[seenProjects.size - 1 % PROJECT_PALETTE.length];
    }
  }

  const tiles: AgentTileData[] = agents.map(agent => {
    const sa = schedulerStatus?.agents?.find(s => s.id === agent.id);
    const agentExecs = executions.filter(e => e.agentId === agent.id);
    const last5 = agentExecs.slice(0, 5).map(e => e.status);
    while (last5.length < 5) last5.push("" as any);

    const recentFails = agentExecs.filter(e => e.status === "failed" || e.status === "timeout").length;
    const ageSec = agent.lastHeartbeatAt ? (Date.now() - new Date(agent.lastHeartbeatAt).getTime()) / 1000 : Infinity;

    let status: AgentTileData["status"] = "offline";
    let statusLabel = "Offline";
    if (agent.archivedAt) { status = "archived"; statusLabel = "Archived"; }
    else if (!agent.enabled) { status = "disabled"; statusLabel = "Disabled"; }
    else if (ageSec < 30) { status = "online"; statusLabel = "Online"; }
    else if (ageSec < 60) { status = "degraded"; statusLabel = `Degraded · ${Math.round(ageSec)}s`; }
    else { status = "offline"; statusLabel = "Offline"; }

    return {
      agent,
      projectColor: projectColorMap[agent.projectId] ?? "#64748b",
      status,
      statusLabel,
      last5Dots: last5 as AgentTileData["last5Dots"],
      runningCount: agent.activeExecutionCount ?? 0,
      nextRunAt: sa?.nextRunAt ?? null,
      lastRunAt: agent.lastExecutionAt ?? null,
      recentFailures: recentFails,
    };
  });

  // Sort: problem agents first
  tiles.sort((a, b) => {
    const severity = (t: AgentTileData) => {
      if (t.status === "offline" || t.recentFailures > 0) return 0;
      if (t.status === "degraded") return 1;
      if (t.status === "disabled" || t.status === "archived") return 2;
      return 3; // online
    };
    const s = severity(a) - severity(b);
    if (s !== 0) return s;
    return a.agent.name.localeCompare(b.agent.name);
  });

  if (!tiles.length) {
    return (
      <div className="panel" style={{ textAlign: "center", padding: "2rem", color: "#64748b", fontSize: "0.85rem" }}>
        No agents registered. Agents auto-register when an executor connects via the SDK.
      </div>
    );
  }

  return (
    <div className="agent-health-grid">
      {tiles.map(tile => (
        <div
          key={tile.agent.id}
          className={`agent-health-tile ${tile.status === "offline" || tile.recentFailures > 0 ? "agent-health-tile--problem" : ""}`}
          style={{ borderLeftColor: tile.projectColor }}
          onClick={() => onOpenAgent(tile.agent)}
          title={`${tile.agent.displayName} · ${tile.statusLabel}${tile.agent.cronExpression ? " · " + tile.agent.cronExpression : ""}${tile.nextRunAt ? " · next " + new Date(tile.nextRunAt).toLocaleTimeString() : ""}`}
        >
          {/* Type icon + name */}
          <div className="agent-health-tile__header">
            <span className="agent-health-tile__type" title={tile.agent.agentType === "llm_agent" ? "LLM Agent" : "Cron Task"}>
              {TYPE_ICON[tile.agent.agentType] ?? "•"}
            </span>
            <span className="agent-health-tile__name">{tile.agent.displayName}</span>
          </div>

          {/* Status + running count */}
          <div className="agent-health-tile__status-row">
            <span className={`status-dot status-dot--${tile.status === "online" ? "success" : tile.status === "degraded" ? "warning" : tile.status === "offline" ? "danger" : "neutral"}${tile.status === "online" ? " pulse" : ""}`} />
            <span className="agent-health-tile__status-label">{tile.statusLabel}</span>
            {tile.runningCount > 0 ? (
              <span className="agent-health-tile__running">{tile.runningCount} running</span>
            ) : null}
          </div>

          {/* Description */}
          {tile.agent.description ? (
            <div className="agent-health-tile__desc">{tile.agent.description}</div>
          ) : null}

          {/* Last 5 execution dots */}
          <div className="agent-health-tile__dots">
            {tile.last5Dots.map((dot, i) => (
              <span
                key={i}
                className={`agent-health-tile__dot ${dot ? "agent-health-tile__dot--" + (DOT_TONES[dot] ?? "neutral") : "agent-health-tile__dot--empty"}`}
                title={dot ?? "no data"}
              />
            ))}
          </div>

          {/* Cron indicator */}
          {tile.agent.cronExpression ? (
            <div className="agent-health-tile__cron">
              <code>{tile.agent.cronExpression}</code>
            </div>
          ) : null}

          {/* Project color stripe is the left border — already rendered via CSS */}
        </div>
      ))}
    </div>
  );
}
