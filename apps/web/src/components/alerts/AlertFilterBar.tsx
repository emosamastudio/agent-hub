interface AlertFilterBarProps {
  severity: string;
  acknowledged: string;
  onChange: (patch: Record<string, string>) => void;
}

export function AlertFilterBar({ severity, acknowledged, onChange }: AlertFilterBarProps) {
  const activeCount = [severity, acknowledged].filter(v => v).length;

  return (
    <div className="alert-filter-bar">
      <div className="alert-filter-bar__row">
        <div className="alert-filter-bar__segments">
          {["", "critical", "warning", "info"].map(s => (
            <button key={s} className={`alert-filter-bar__seg ${severity === s ? "active" : ""}`} onClick={() => onChange({ severity: s })}>
              {s === "" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div className="alert-filter-bar__segments">
          {["", "unacknowledged", "acknowledged"].map(a => (
            <button key={a} className={`alert-filter-bar__seg ${acknowledged === a ? "active" : ""}`} onClick={() => onChange({ acknowledged: a })}>
              {a === "" ? "All" : a === "unacknowledged" ? "Active" : "Acknowledged"}
            </button>
          ))}
        </div>
        {activeCount > 0 ? <button onClick={() => onChange({ severity: "", acknowledged: "" })} className="ghost-button">Reset</button> : null}
      </div>
    </div>
  );
}
