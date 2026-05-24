import type { TraceSpan } from "./types.js";

export interface AgentSettingsFormValues {
  displayName: string;
  cronExpression: string;
  handlerName: string;
  misfirePolicy: "fire_once" | "fire_all" | "drop";
  concurrency: string;
  maxPendingQueue: string;
  timeoutSeconds: string;
  retryMax: string;
  retryBackoffBaseMs: string;
  idempotencyWindowSeconds: string;
}

export interface ExecutionFilterValues {
  agentId: string;
  status: string;
  triggerType: string;
}

export interface ExecutionQueryOptions {
  limit?: number;
  offset?: number;
}

export const DEFAULT_EXECUTION_PAGE_SIZE = 50;

function parseIntegerSetting(value: string, label: string, min: number): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${label} must be an integer greater than or equal to ${min}.`);
  }
  return parsed;
}

export function executionDisplayTime(execution: {
  startedAt?: string | null;
  scheduledAt?: string | null;
  createdAt?: string | null;
}): string | null {
  return execution.startedAt ?? execution.scheduledAt ?? execution.createdAt ?? null;
}

export function executionQueryParamsFromFilters(
  values: ExecutionFilterValues,
  options: ExecutionQueryOptions = {},
): Record<string, string> {
  const params: Record<string, string> = {
    limit: String(options.limit ?? DEFAULT_EXECUTION_PAGE_SIZE),
  };
  if (options.offset && options.offset > 0) params.offset = String(options.offset);
  if (values.agentId) params.agent_id = values.agentId;
  if (values.status) params.status = values.status;
  if (values.triggerType) params.trigger_type = values.triggerType;
  return params;
}

export function agentSettingsPatchFromForm(values: AgentSettingsFormValues) {
  const displayName = values.displayName.trim();
  if (!displayName) {
    throw new Error("Display name is required.");
  }

  return {
    displayName,
    cronExpression: values.cronExpression.trim() || null,
    handlerName: values.handlerName.trim() || null,
    misfirePolicy: values.misfirePolicy,
    concurrency: parseIntegerSetting(values.concurrency, "Concurrency", 1),
    maxPendingQueue: parseIntegerSetting(values.maxPendingQueue, "Queue cap", 0),
    timeoutSeconds: parseIntegerSetting(values.timeoutSeconds, "Timeout", 1),
    retryMax: parseIntegerSetting(values.retryMax, "Retries", 0),
    retryBackoffBaseMs: parseIntegerSetting(values.retryBackoffBaseMs, "Backoff", 0),
    idempotencyWindowSeconds: parseIntegerSetting(
      values.idempotencyWindowSeconds,
      "Idempotency window",
      1,
    ),
  };
}

export function parseTriggerPayload(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Payload must be valid JSON.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

export interface Round {
  turnIndex: number;
  spans: TraceSpan[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalLatencyMs: number;
}

export function groupTracesIntoTurns(spans: TraceSpan[]): Round[] {
  const map = new Map<number, TraceSpan[]>();
  for (const span of spans) {
    const ti = span.turnIndex ?? span.turn_index ?? 0;
    if (!map.has(ti)) map.set(ti, []);
    map.get(ti)!.push(span);
  }
  const rounds: Round[] = [];
  for (const [turnIndex, turnSpans] of map) {
    let totalTokensIn = 0, totalTokensOut = 0, totalLatencyMs = 0;
    for (const s of turnSpans) {
      totalTokensIn += s.inputTokens ?? s.input_tokens ?? 0;
      totalTokensOut += s.outputTokens ?? s.output_tokens ?? 0;
      totalLatencyMs += s.latencyMs ?? s.latency_ms ?? 0;
    }
    rounds.push({ turnIndex, spans: turnSpans.sort((a, b) => (a.spanIndex ?? a.span_index ?? 0) - (b.spanIndex ?? b.span_index ?? 0)), totalTokensIn, totalTokensOut, totalLatencyMs });
  }
  rounds.sort((a, b) => a.turnIndex - b.turnIndex);
  return rounds;
}
