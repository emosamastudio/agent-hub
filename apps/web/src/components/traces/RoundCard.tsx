import { useState } from "react";
import type { Round } from "../../lib/dashboard-helpers.js";
import { MessageBubble } from "./MessageBubble.js";

interface RoundCardProps {
  round: Round;
  defaultExpanded?: boolean;
}

export function RoundCard({ round, defaultExpanded }: RoundCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const totalTokens = round.totalTokensIn + round.totalTokensOut;

  return (
    <div className="round-card">
      <div className="round-card__header" onClick={() => setExpanded(!expanded)}>
        <span className="round-card__toggle">{expanded ? "▼" : "▶"}</span>
        <strong>Round {round.turnIndex}</strong>
        <span className="round-card__stats">
          {totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}K tokens` : ""}
          {round.totalLatencyMs > 0 ? ` · ${round.totalLatencyMs}ms` : ""}
        </span>
        <span className="round-card__spans">{round.spans.length} msg</span>
      </div>
      {expanded ? (
        <div className="round-card__body">
          {round.spans.map((span, i) => <MessageBubble key={i} span={span} />)}
        </div>
      ) : null}
    </div>
  );
}
