import type { Agent, Project, ExecutionFilterValues } from "../../lib/types.js";

interface ExecutionFilterBarProps {
  agents: Agent[];
  projects: Project[];
  filters: ExecutionFilterValues;
  onChange: (filters: ExecutionFilterValues) => void;
}

export function ExecutionFilterBar({ agents, projects, filters, onChange }: ExecutionFilterBarProps) {
  const update = (patch: Partial<ExecutionFilterValues>) => {
    onChange({ ...filters, ...patch });
  };

  const reset = () => onChange({});

  const activeCount = Object.values(filters).filter(v => v !== undefined && v !== "" && (Array.isArray(v) ? v.length > 0 : true)).length;

  const filteredAgents = filters.projectId ? agents.filter(a => a.projectId === filters.projectId) : agents;

  return (
    <div className="execution-filter-bar">
      <div className="execution-filter-bar__row">
        <select value={filters.projectId ?? ""} onChange={e => update({ projectId: e.target.value || undefined })}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        <select value={filters.agentId ?? ""} onChange={e => update({ agentId: e.target.value || undefined })}>
          <option value="">All Agents</option>
          {filteredAgents.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
        </select>
        <select value={filters.triggerType ?? ""} onChange={e => update({ triggerType: e.target.value || undefined })}>
          <option value="">All Triggers</option>
          <option value="cron">cron</option>
          <option value="manual">manual</option>
          <option value="api">api</option>
          <option value="agent">agent</option>
          <option value="retry">retry</option>
        </select>
        <div className="execution-filter-bar__statuses">
          {["queued", "running", "success", "failed", "timeout", "cancelled"].map(s => (
            <label key={s} className="execution-filter-bar__checkbox">
              <input
                type="checkbox"
                checked={filters.statuses?.includes(s) ?? false}
                onChange={e => {
                  const next = filters.statuses ? [...filters.statuses] : [];
                  if (e.target.checked) { if (!next.includes(s)) next.push(s); }
                  else { const idx = next.indexOf(s); if (idx >= 0) next.splice(idx, 1); }
                  update({ statuses: next.length > 0 ? next : undefined });
                }}
              />
              <span className={`status-dot status-dot--${s}`} />
              {s}
            </label>
          ))}
        </div>
        {activeCount > 0 ? <button onClick={reset} className="ghost-button">Reset ({activeCount})</button> : null}
      </div>
    </div>
  );
}
