import type { Project } from "../../lib/types.js";

interface AgentFilterBarProps {
  projects: Project[];
  search: string;
  projectId: string;
  agentType: string;
  status: string;
  schedule: string;
  onChange: (patch: Record<string, string>) => void;
}

export function AgentFilterBar({ projects, search, projectId, agentType, status, schedule, onChange }: AgentFilterBarProps) {
  const reset = () => onChange({ search: "", projectId: "", agentType: "", status: "", schedule: "" });
  const activeCount = [search, projectId, agentType, status, schedule].filter((v) => v).length;

  return (
    <div className="agent-filter-bar">
      <div className="agent-filter-bar__row">
        <input
          type="text"
          placeholder="Search agents..."
          value={search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="agent-filter-bar__search"
        />
        <select value={projectId} onChange={(e) => onChange({ projectId: e.target.value })}>
          <option value="">All Projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <div className="agent-filter-bar__segments">
          {["", "llm_agent", "cron_task"].map((t) => (
            <button
              key={t}
              className={`agent-filter-bar__seg ${agentType === t ? "active" : ""}`}
              onClick={() => onChange({ agentType: t })}
            >
              {t === "" ? "All" : t === "llm_agent" ? "LLM" : "Cron"}
            </button>
          ))}
        </div>
        <div className="agent-filter-bar__segments">
          {["", "online", "offline", "disabled"].map((s) => (
            <button
              key={s}
              className={`agent-filter-bar__seg ${status === s ? "active" : ""}`}
              onClick={() => onChange({ status: s })}
            >
              {s === "" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div className="agent-filter-bar__segments">
          {["", "cron", "manual"].map((s) => (
            <button
              key={s}
              className={`agent-filter-bar__seg ${schedule === s ? "active" : ""}`}
              onClick={() => onChange({ schedule: s })}
            >
              {s === "" ? "All" : s === "cron" ? "Cron" : "Manual"}
            </button>
          ))}
        </div>
        {activeCount > 0 ? (
          <button onClick={reset} className="ghost-button">
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}
