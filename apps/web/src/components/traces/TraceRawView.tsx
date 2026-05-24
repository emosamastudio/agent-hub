import type { TraceSpan } from "../../lib/types.js";

interface TraceRawViewProps {
  traces: TraceSpan[];
}

export function TraceRawView({ traces }: TraceRawViewProps) {
  return (
    <div className="trace-raw-view">
      <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem", maxHeight: "70vh", overflow: "auto" }}>
        {JSON.stringify(traces, null, 2)}
      </pre>
    </div>
  );
}
