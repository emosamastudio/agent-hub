import type { TraceSpan } from "../../lib/types.js";

interface MessageBubbleProps {
  span: TraceSpan;
}

export function MessageBubble({ span }: MessageBubbleProps) {
  const role = span.role ?? "unknown";
  const content = role === "user"
    ? (span.inputContent ?? span.input_content)
    : (span.outputContent ?? span.output_content);
  const model = span.model;
  const latencyMs = span.latencyMs ?? span.latency_ms;
  const inputTokens = span.inputTokens ?? span.input_tokens;
  const outputTokens = span.outputTokens ?? span.output_tokens;
  const toolCalls = (span.toolCalls ?? span.tool_calls) as any[];

  const roleLabel = role === "user" ? "User"
    : role === "assistant" ? (model ?? "Assistant")
    : role === "tool" ? "Tool"
    : role === "system" ? "System"
    : role;

  const bubbleClass = role === "user" ? "msg-bubble--user"
    : role === "assistant" ? "msg-bubble--assistant"
    : role === "tool" ? "msg-bubble--tool"
    : "msg-bubble--system";

  if (!content && !toolCalls?.length) return null;

  return (
    <div className={`msg-bubble ${bubbleClass}`}>
      <div className="msg-bubble__header">
        <span className="msg-bubble__role">{roleLabel}</span>
        <span className="msg-bubble__meta">
          {inputTokens != null ? <span className="meta-chip meta-chip--in">↑{inputTokens}</span> : null}
          {outputTokens != null ? <span className="meta-chip meta-chip--out">↓{outputTokens}</span> : null}
          {latencyMs != null ? <span className="meta-chip meta-chip--latency">{latencyMs}ms</span> : null}
        </span>
      </div>
      {content ? <div className="msg-bubble__content">{content}</div> : null}
      {Array.isArray(toolCalls) && toolCalls.length > 0 ? (
        <div className="msg-bubble__tools">
          {toolCalls.map((tc: any, i: number) => {
            const fn = tc?.function ?? tc;
            const name = fn?.name ?? "unknown";
            return (
              <span key={i} className="tool-tag">🔧 {name}</span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
