import { groupTracesIntoTurns } from "../../lib/dashboard-helpers.js";
import type { TraceSpan } from "../../lib/types.js";
import { RoundCard } from "./RoundCard.js";

interface TraceChatViewProps {
  traces: TraceSpan[];
}

export function TraceChatView({ traces }: TraceChatViewProps) {
  if (!traces.length) {
    return <div className="empty-state">No traces recorded for this execution.</div>;
  }
  const rounds = groupTracesIntoTurns(traces);
  const totalTokens = traces.reduce((sum, t) => sum + (t.inputTokens ?? t.input_tokens ?? 0) + (t.outputTokens ?? t.output_tokens ?? 0), 0);

  return (
    <div className="trace-chat-view">
      <div className="trace-chat-view__summary">
        <span>{rounds.length} Rounds</span>
        <span>{traces.length} Spans</span>
        <span>{totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}K tokens total` : ""}</span>
      </div>
      {rounds.map((round, i) => (
        <RoundCard key={round.turnIndex} round={round} defaultExpanded={i === rounds.length - 1} />
      ))}
    </div>
  );
}
