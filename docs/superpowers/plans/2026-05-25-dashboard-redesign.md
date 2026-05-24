# Agent Hub Dashboard Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the single-file 3,833-line dashboard into a multi-page operations console with conversational trace viewer, rich execution history, health overview, multi-project scoping, scheduler management, and alert center — modeled after xxl-job, Temporal, and Vercel patterns.

**Architecture:** Strip the current App.tsx into ~30 focused files under `components/`, `pages/`, `hooks/`, `context/`, and `lib/`. Replace 35 `useState` hooks with `useReducer` + Context. Route WebSocket events to targeted state updates instead of full `loadData()` refreshes. Keep the existing dark theme and custom component system (no external UI library).

**Tech Stack:** React 18 + TypeScript 6, Vite 8, existing CSS design tokens, `croner` for schedule preview, hand-rolled SVG charts (no chart library dependency for Phase 1).

---

## File Map

### New files to create

```
apps/web/src/
├── lib/types.ts                          # All interfaces extracted from App.tsx
├── lib/time.ts                           # Relative time formatting
├── i18n/translations.ts                  # zh-CN + en-US objects extracted from App.tsx
├── context/DashboardContext.tsx           # UI state provider (page, projectScope, language)
├── context/DataContext.tsx                # Server data provider (agents, executions, stats)
├── hooks/useWebSocket.ts                 # Smart event routing
├── hooks/useAgents.ts                    # Agent query + mutation hooks
├── hooks/useExecutions.ts                # Execution query + mutation hooks
├── components/layout/TopBar.tsx          # Breadcrumbs, search, language, refresh
├── components/layout/ProjectSelector.tsx # Project scope dropdown
├── components/layout/GlobalSearch.tsx    # Cmd+K command palette
├── components/ui/Toggle.tsx             # On/off toggle switch
├── components/ui/Banner.tsx             # Error/warning/info banner
├── components/ui/EmptyState.tsx         # Empty placeholder
├── components/ui/Sparkline.tsx          # Hand-rolled SVG sparkline
├── components/agents/AgentFilterBar.tsx  # Search + multi-select project + type/status/schedule segments
├── components/agents/AgentBulkToolbar.tsx# Checkbox selection + bulk actions
├── components/agents/ScheduleTimeline.tsx# Horizontal bar with "Now" marker + N tick marks
├── components/executions/ExecutionFilterBar.tsx # Multi-status, time range, duration range, search
├── components/executions/ExecutionPagination.tsx # Page size + page numbers + record count
├── components/executions/BulkActionBar.tsx  # Bulk cancel/rerun
├── components/executions/SavedViews.tsx     # Save/load filter presets from localStorage
├── components/traces/TraceChatView.tsx      # Conversation flow: RoundCard + MessageBubble
├── components/traces/TraceTimelineView.tsx  # Horizontal timeline with colored spans
├── components/traces/RoundCard.tsx          # Single turn: header + collapsible body
├── components/traces/MessageBubble.tsx      # User/Assistant/Tool bubble with role styling
├── components/traces/ToolCallCard.tsx       # Inline tool call with expandable args
├── components/traces/SubAgentGroup.tsx      # Nested parallel sub-agent group
├── components/traces/TraceRawView.tsx       # Syntax-highlighted collapsible JSON tree
├── components/scheduler/SchedulerHealthCard.tsx  # Running status, tick stats, step health
├── components/scheduler/CronOverview.tsx    # Expandable cron agent list with status dots
├── components/alerts/AlertFilterBar.tsx     # Severity, project, agent, time, ack status
├── components/alerts/AlertDetailPanel.tsx   # Rule, context JSON, related executions
├── components/alerts/AlertRulesConfig.tsx   # Thresholds, dedupe, notification channels
├── pages/SchedulerPage.tsx
├── pages/AlertsPage.tsx
├── pages/SettingsPage.tsx
```

### Files to modify

```
apps/web/src/App.tsx                        # Strip to ~200 lines
apps/web/src/App.css                        # Add new CSS classes
apps/web/src/lib/api.ts                     # Add 5 new fetch functions
apps/web/src/lib/dashboard-helpers.ts       # Add new types + helpers
apps/server/src/http/routes.ts              # Add /api/stats/throughput, /api/agents/:id/cooldowns, extend /api/executions
apps/server/src/repositories/execution-repository.ts  # countByHour, pagination, statuses[] filter
apps/server/src/repositories/trace-repository.ts      # getNextTurnIndex (already added)
apps/server/src/db/schema.ts                # Add scheduler_events table (optional Phase 2)
```

---

## Phase 0 — Foundation (before any page changes)

### Task 0.1: Extract types to lib/types.ts

**Files:**
- Create: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/App.tsx:168-260`

Move all TypeScript interfaces from App.tsx to a single types file. This is zero-behavior-change refactoring.

- [ ] **Step 1: Create types file**

Copy every `interface` and `type` declaration from App.tsx lines 168-260 into `apps/web/src/lib/types.ts`:

```typescript
// apps/web/src/lib/types.ts

export type Page = "overview" | "agents" | "executions" | "detail" | "agent-detail";

export type DashboardLanguage = "zh-CN" | "en-US";

export interface Project {
  id: string; name: string; displayName: string; description?: string | null;
  status: string; workspacePath?: string | null;
  allowTriggerFrom?: string[]; triggerRateLimitPerSec?: number;
  costConfig?: Record<string, unknown>; providerConfig?: Record<string, unknown> | null;
  createdAt?: string; updatedAt?: string;
}

export interface Agent {
  id: string; projectId: string; name: string; displayName: string;
  description?: string | null; agentType: string;
  cronExpression?: string | null; enabled: boolean;
  misfirePolicy?: string; concurrency?: number; maxPendingQueue?: number;
  timeoutSeconds?: number; retryMax?: number; retryBackoffBaseMs?: number;
  maxTurns?: number | null; maxCostUsd?: string | null;
  handlerName?: string | null; executorHost?: string | null;
  executorStatus?: string; inputSchema?: unknown;
  allowTriggerBy?: unknown; idempotencyWindowSeconds?: number;
  labels?: Record<string, unknown>; providerConfig?: Record<string, unknown> | null;
  lastHeartbeatAt?: string | null; lastExecutionAt?: string | null;
  activeExecutionCount?: number; archivedAt?: string | null;
  createdAt?: string; updatedAt?: string;
  projectName?: string; projectDisplayName?: string;
  recentExecutions?: Execution[];
}

export interface Execution {
  id: string; agentId: string; triggerType: string; triggeredBy?: string | null;
  parentExecutionId?: string | null; rootExecutionId?: string | null;
  triggerDepth?: number; idempotencyKey?: string | null;
  status: string; scheduledAt?: string | null; startedAt?: string | null;
  finishedAt?: string | null; durationMs?: number | null;
  lastActivityAt?: string | null; progressPercent?: number | null;
  progressMessage?: string | null; inputPayload?: unknown;
  resultSummary?: string | null; resultData?: unknown;
  errorMessage?: string | null; errorStack?: string | null;
  traceCountExpected?: number | null; traceCountActual?: number;
  traceIncomplete?: boolean; retryCount?: number; retryOf?: string | null;
  executorHost?: string | null; createdAt?: string;
  agentName?: string; projectName?: string; projectId?: string;
}

export interface TraceSpan {
  id?: string; executionId?: string;
  turnIndex?: number; turn_index?: number;
  spanIndex?: number; span_index?: number;
  parentSpanId?: string | null; role?: string;
  spanType?: string; span_type?: string;
  model?: string | null; provider?: string | null;
  inputContent?: string | null; input_content?: string | null;
  outputContent?: string | null; output_content?: string | null;
  toolCalls?: unknown; tool_calls?: unknown;
  toolResults?: unknown; tool_results?: unknown;
  inputTokens?: number | null; input_tokens?: number | null;
  outputTokens?: number | null; output_tokens?: number | null;
  costEstimate?: string | null;
  latencyMs?: number | null; latency_ms?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string; created_at?: string;
}

export interface DashboardStats {
  agentsTotal?: number; agents_total?: number;
  agentsOnline?: number; agents_online?: number;
  recentSuccessRate?: string; recent_success_rate?: string;
  recentFailures?: number; recent_failures?: number;
}

export interface AlertEntry {
  id: number; ruleName?: string; rule_name?: string;
  severity?: string; agentId?: string | null; agent_id?: string | null;
  message?: string; context?: unknown;
  acknowledgedAt?: string | null; acknowledged_at?: string | null;
  acknowledgedBy?: string | null; acknowledged_by?: string | null;
  createdAt?: string; created_at?: string;
  agentName?: string; agentDisplayName?: string;
}

export interface SchedulerRuntimeStats {
  running?: boolean; tickMs?: number;
  startedAt?: string | null; started_at?: string | null;
  tickCount?: number; tick_count?: number;
  overlapSkippedCount?: number; overlap_skipped_count?: number;
  lockSkippedCount?: number; lock_skipped_count?: number;
  lastTickDurationMs?: number; last_tick_duration_ms?: number;
  lastTickErrorCount?: number; last_tick_error_count?: number;
  lastTickStepErrors?: Array<{ step: string; message: string }>;
  last_tick_step_errors?: Array<{ step: string; message: string }>;
}

export interface SchedulerAgentStatus {
  id: string; name: string; displayName: string;
  agentType: string; projectId: string;
  enabled: boolean; executorStatus: string;
  cronExpression?: string | null; misfirePolicy?: string;
  concurrency: number; maxPendingQueue: number;
  queueDepth: number; runningCount: number; scheduledCount: number;
  dispatchState: string; scheduleState: string;
  nextRunAt?: string | null; dueRunAt?: string | null;
  cronError?: string | null;
  lastHeartbeatAt?: string | null;
  lastExecutionAt?: string | null;
  runningExecutions?: Array<{ id: string; status: string; startedAt?: string }>;
}

export interface ExecutionFilterValues {
  projectId?: string; agentId?: string;
  statuses?: string[]; triggerType?: string;
  since?: string; until?: string;
  search?: string; limit?: number; offset?: number;
}

export interface SavedView {
  name: string;
  filters: ExecutionFilterValues;
  createdAt: string;
}
```

- [ ] **Step 2: Add import in App.tsx**

```typescript
import type { Page, Project, Agent, Execution, TraceSpan, DashboardStats, AlertEntry, SchedulerRuntimeStats, SchedulerAgentStatus, ExecutionFilterValues } from "./lib/types.js";
```

Remove the inline interface declarations (lines 168-260 of App.tsx) that are now in types.ts.

- [ ] **Step 3: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/App.tsx
git commit -m "refactor: extract types to lib/types.ts"
```

### Task 0.2: Extract i18n to i18n/translations.ts

**Files:**
- Create: `apps/web/src/i18n/translations.ts`
- Modify: `apps/web/src/App.tsx:267-615`

- [ ] **Step 1: Create translations file**

Move both translation objects out of App.tsx into `apps/web/src/i18n/translations.ts`:

```typescript
// apps/web/src/i18n/translations.ts

export type DashboardLanguage = "zh-CN" | "en-US";

const zh: Record<string, string> = {
  // ... copy exact content from App.tsx lines 267-413
};

const en: Record<string, string> = {
  // ... copy exact content from App.tsx lines 417-615
};

export function getTranslations(lang: DashboardLanguage): Record<string, string> {
  return lang === "zh-CN" ? zh : en;
}

export function t(key: string, translations: Record<string, string>): string {
  return translations[key] ?? key;
}
```

- [ ] **Step 2: Import in App.tsx**

```typescript
import { getTranslations, t as translate, type DashboardLanguage } from "./i18n/translations.js";
```

Replace the inline objects with calls to `getTranslations(language)`. Replace `t(key)` with `translate(key, translations)`.

- [ ] **Step 3: Type-check + test build**

```bash
cd apps/web && npx tsc --noEmit && npx vite build
```
Expected: no errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/i18n/ apps/web/src/App.tsx
git commit -m "refactor: extract i18n translations to separate module"
```

---

## Phase 1 — Trace Viewer: Conversational Flow (P0)

### Task 1.1: Create TraceChatView and RoundCard components

**Files:**
- Create: `apps/web/src/components/traces/TraceChatView.tsx`
- Create: `apps/web/src/components/traces/RoundCard.tsx`
- Create: `apps/web/src/components/traces/MessageBubble.tsx`
- Create: `apps/web/src/components/traces/ToolCallCard.tsx`
- Create: `apps/web/src/components/traces/SubAgentGroup.tsx`
- Create: `apps/web/src/components/traces/TraceRawView.tsx`
- Modify: `apps/web/src/App.tsx:3448-3630` (replace trace rendering with new components)

- [ ] **Step 1: Group traces into rounds utility**

```typescript
// apps/web/src/lib/dashboard-helpers.ts — add:

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
    rounds.push({ turnIndex, spans: turnSpans, totalTokensIn, totalTokensOut, totalLatencyMs });
  }
  rounds.sort((a, b) => a.turnIndex - b.turnIndex);
  return rounds;
}
```

- [ ] **Step 2: Create MessageBubble component**

```typescript
// apps/web/src/components/traces/MessageBubble.tsx

import type { TraceSpan } from "../../lib/types.js";

interface MessageBubbleProps {
  span: TraceSpan;
  defaultExpanded?: boolean;
}

export function MessageBubble({ span, defaultExpanded }: MessageBubbleProps) {
  const role = span.role ?? "unknown";
  const content = role === "user" ? (span.inputContent ?? span.input_content) : (span.outputContent ?? span.output_content);
  const model = span.model;
  const latencyMs = span.latencyMs ?? span.latency_ms;
  const inputTokens = span.inputTokens ?? span.input_tokens;
  const outputTokens = span.outputTokens ?? span.output_tokens;
  const toolCalls = (span.toolCalls ?? span.tool_calls) as any[];
  const metadata = span.metadata as Record<string, unknown> | undefined;
  const rawInput = metadata?._rawInput as string | undefined;
  const rawOutput = metadata?._rawOutput as string | undefined;

  const roleLabel = role === "user" ? "User" : role === "assistant" ? model ?? "Assistant" : role === "tool" ? "Tool" : role;
  const bubbleClass = role === "user" ? "msg-bubble--user" : role === "assistant" ? "msg-bubble--assistant" : role === "tool" ? "msg-bubble--tool" : "msg-bubble--system";

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
      {content ? (
        <div className="msg-bubble__content">{content}</div>
      ) : null}
      {Array.isArray(toolCalls) && toolCalls.length > 0 ? (
        <div className="msg-bubble__tool-calls">
          {toolCalls.map((tc: any, i: number) => (
            <ToolCallCard key={i} toolCall={tc} defaultExpanded={defaultExpanded} />
          ))}
        </div>
      ) : null}
      {(rawInput || rawOutput) ? (
        <details className="msg-bubble__raw">
          <summary>查看原始数据</summary>
          {rawInput ? <pre>{typeof rawInput === "string" ? rawInput.slice(0, 2000) : JSON.stringify(rawInput, null, 2).slice(0, 2000)}</pre> : null}
          {rawOutput ? <pre>{typeof rawOutput === "string" ? rawOutput.slice(0, 2000) : JSON.stringify(rawOutput, null, 2).slice(0, 2000)}</pre> : null}
        </details>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Create ToolCallCard**

```typescript
// apps/web/src/components/traces/ToolCallCard.tsx

interface ToolCallCardProps {
  toolCall: any;
  defaultExpanded?: boolean;
}

export function ToolCallCard({ toolCall, defaultExpanded }: ToolCallCardProps) {
  const fn = toolCall?.function ?? toolCall;
  const name = fn?.name ?? toolCall?.name ?? "unknown";
  const args = fn?.arguments ?? toolCall?.arguments ?? {};
  const argsStr = typeof args === "string" ? args : JSON.stringify(args, null, 2);

  return (
    <div className="tool-call-card">
      <div className="tool-call-card__header">
        <span className="tool-call-card__icon">🔧</span>
        <span className="tool-call-card__name">{name}</span>
      </div>
      <details open={defaultExpanded}>
        <summary className="tool-call-card__summary">参数</summary>
        <pre className="tool-call-card__args">{argsStr.slice(0, 1000)}</pre>
      </details>
    </div>
  );
}
```

- [ ] **Step 4: Create RoundCard**

```typescript
// apps/web/src/components/traces/RoundCard.tsx
import { useState } from "react";
import type { Round } from "../../lib/dashboard-helpers.js";
import { MessageBubble } from "./MessageBubble.js";

interface RoundCardProps {
  round: Round;
  defaultExpanded?: boolean;
}

export function RoundCard({ round, defaultExpanded }: RoundCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  return (
    <div className="round-card">
      <div className="round-card__header" onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer" }}>
        <span className="round-card__toggle">{expanded ? "▼" : "▶"}</span>
        <strong>Round {round.turnIndex}</strong>
        <span className="round-card__stats">
          {round.totalTokensIn + round.totalTokensOut > 0 ? `${(round.totalTokensIn + round.totalTokensOut) / 1000}K tokens` : ""}
          {round.totalLatencyMs > 0 ? ` · ${round.totalLatencyMs}ms` : ""}
        </span>
        <span className="round-card__spans">{round.spans.length} spans</span>
      </div>
      {expanded ? (
        <div className="round-card__body">
          {round.spans.map((span, i) => (
            <MessageBubble key={i} span={span} defaultExpanded={false} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Create TraceChatView**

```typescript
// apps/web/src/components/traces/TraceChatView.tsx
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
        <span>{totalTokens > 0 ? `${(totalTokens / 1000).toFixed(1)}K tokens` : ""}</span>
      </div>
      {rounds.map((round, i) => (
        <RoundCard key={round.turnIndex} round={round} defaultExpanded={i === rounds.length - 1} />
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Create TraceRawView**

```typescript
// apps/web/src/components/traces/TraceRawView.tsx
import type { TraceSpan } from "../../lib/types.js";

interface TraceRawViewProps {
  traces: TraceSpan[];
}

export function TraceRawView({ traces }: TraceRawViewProps) {
  const json = JSON.stringify(traces, null, 2);
  return (
    <div className="trace-raw-view">
      <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem", maxHeight: "70vh", overflow: "auto" }}>
        {json}
      </pre>
    </div>
  );
}
```

- [ ] **Step 7: Wire into App.tsx detail page**

In the execution detail page's trace section (App.tsx ~line 3448), replace the entire trace rendering block with:

```typescript
import { TraceChatView } from "./components/traces/TraceChatView.js";
import { TraceRawView } from "./components/traces/TraceRawView.js";

// Inside the detail page render:
const [traceViewMode, setTraceViewMode] = useState<"chat" | "raw">("chat");

// ... in the JSX:
<div className="trace-viewer">
  <div className="trace-toolbar">
    <div className="trace-toolbar__toggle">
      <button className={traceViewMode === "chat" ? "active" : ""} onClick={() => setTraceViewMode("chat")}>Chat</button>
      <button className={traceViewMode === "raw" ? "active" : ""} onClick={() => setTraceViewMode("raw")}>Raw JSON</button>
    </div>
  </div>
  {traceViewMode === "chat"
    ? <TraceChatView traces={traces} />
    : <TraceRawView traces={traces} />
  }
</div>
```

- [ ] **Step 8: Add CSS for trace components**

Add to `apps/web/src/App.css`:

```css
/* Trace Chat View */
.trace-chat-view { display: flex; flex-direction: column; gap: 1rem; }
.trace-chat-view__summary { font-size: 0.8rem; color: var(--color-muted); display: flex; gap: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border-default); }

/* Round Card */
.round-card { background: var(--bg-panel); border: 1px solid var(--border-default); border-radius: 12px; overflow: hidden; }
.round-card__header { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 1rem; font-size: 0.85rem; }
.round-card__header:hover { background: rgba(255,255,255,0.03); }
.round-card__toggle { font-size: 0.65rem; width: 16px; }
.round-card__stats { color: var(--color-muted); font-size: 0.78rem; margin-left: auto; }
.round-card__spans { font-size: 0.72rem; color: var(--color-muted); }
.round-card__body { padding: 0 1rem 1rem; display: flex; flex-direction: column; gap: 0.75rem; }

/* Message Bubbles */
.msg-bubble { border-left: 3px solid var(--border-default); border-radius: 0 10px 10px 10px; padding: 0.6rem 0.85rem; font-size: 0.85rem; line-height: 1.6; }
.msg-bubble--user { border-left-color: rgba(59,130,246,0.5); background: rgba(59,130,246,0.08); }
.msg-bubble--assistant { border-left-color: rgba(34,197,94,0.4); background: rgba(34,197,94,0.06); }
.msg-bubble--tool { border-left-color: rgba(168,85,247,0.4); background: rgba(168,85,247,0.06); }
.msg-bubble--system { border-left-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.04); }
.msg-bubble__header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
.msg-bubble__role { font-weight: 600; font-size: 0.8rem; }
.msg-bubble__meta { display: flex; gap: 0.4rem; margin-left: auto; }
.msg-bubble__content { white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow: auto; }
.msg-bubble__raw { margin-top: 0.5rem; font-size: 0.72rem; }
.msg-bubble__raw summary { color: var(--color-muted); cursor: pointer; }
.msg-bubble__raw pre { background: var(--bg-primary); padding: 0.5rem; border-radius: 8px; max-height: 150px; overflow: auto; font-size: 0.72rem; }

/* Meta Chips */
.meta-chip { display: inline-flex; align-items: center; padding: 0.1rem 0.4rem; border-radius: 10px; font-size: 0.7rem; font-family: monospace; }
.meta-chip--in { background: rgba(59,130,246,0.15); color: #93c5fd; }
.meta-chip--out { background: rgba(34,197,94,0.15); color: #86efac; }
.meta-chip--latency { background: rgba(245,158,11,0.15); color: #fcd34d; }

/* Tool Call Card */
.tool-call-card { background: rgba(168,85,247,0.08); border: 1px solid rgba(168,85,247,0.2); border-radius: 8px; padding: 0.4rem 0.6rem; margin-top: 0.3rem; }
.tool-call-card__header { display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; font-weight: 500; }
.tool-call-card__icon { font-size: 0.75rem; }
.tool-call-card__summary { font-size: 0.75rem; color: var(--color-muted); cursor: pointer; margin-top: 0.2rem; }
.tool-call-card__args { font-size: 0.72rem; background: var(--bg-primary); padding: 0.4rem; border-radius: 6px; margin-top: 0.2rem; max-height: 120px; overflow: auto; white-space: pre-wrap; }

/* Trace Toolbar */
.trace-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.trace-toolbar__toggle { display: flex; gap: 0; border: 1px solid var(--border-default); border-radius: 8px; overflow: hidden; }
.trace-toolbar__toggle button { padding: 0.3rem 0.75rem; font-size: 0.8rem; background: transparent; border: none; color: var(--text-secondary); cursor: pointer; }
.trace-toolbar__toggle button.active { background: var(--accent-primary); color: white; }

/* Trace Raw View */
.trace-raw-view { background: var(--bg-panel); border: 1px solid var(--border-default); border-radius: 12px; padding: 1rem; }
```

- [ ] **Step 9: Type-check + build**

```bash
cd apps/web && npx tsc --noEmit && npx vite build
```
Expected: no errors, build succeeds.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/traces/ apps/web/src/lib/dashboard-helpers.ts apps/web/src/App.tsx apps/web/src/App.css
git commit -m "feat: conversational trace viewer with round cards and message bubbles"
```

---

## Phase 2 — Execution History Upgrade (P0)

### Task 2.1: Expand execution API

**Files:**
- Modify: `apps/server/src/repositories/execution-repository.ts`
- Modify: `apps/server/src/http/routes.ts`

- [ ] **Step 1: Add `countByHour` to execution repository**

```typescript
// execution-repository.ts — add method:

async countByHour(hours: number) {
  const result = await this.db.execute(sql`
    SELECT
      date_trunc('hour', created_at) AS hour,
      status,
      COUNT(*)::int AS count
    FROM executions
    WHERE created_at > now() - (${hours} || ' hours')::interval
    GROUP BY hour, status
    ORDER BY hour
  `);
  const buckets = new Map<string, Record<string, number>>();
  for (const row of result.rows as any[]) {
    const key = new Date(row.hour).toISOString();
    if (!buckets.has(key)) buckets.set(key, {});
    buckets.get(key)![row.status] = row.count;
  }
  return Array.from(buckets.entries()).map(([hour, counts]) => ({ hour, ...counts }));
}
```

- [ ] **Step 2: Add throughput endpoint**

```typescript
// routes.ts — add:

app.get("/api/stats/throughput", async (request, reply) => {
  const hours = Math.min(Number.parseInt(String(request.query.hours ?? "24"), 10) || 24, 168);
  const buckets = await ctx.executionRepo.countByHour(hours);
  return { buckets };
});
```

- [ ] **Step 3: Type-check + test**

```bash
cd apps/server && npx tsc --noEmit && npx vitest run
```
Expected: no errors, 72+ tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/repositories/execution-repository.ts apps/server/src/http/routes.ts
git commit -m "feat: add throughput stats endpoint for execution history chart"
```

### Task 2.2: Rebuild ExecutionTable with 10 columns

**Files:**
- Create: `apps/web/src/components/executions/ExecutionFilterBar.tsx`
- Create: `apps/web/src/components/executions/ExecutionPagination.tsx`
- Create: `apps/web/src/components/executions/BulkActionBar.tsx`
- Create: `apps/web/src/components/executions/SavedViews.tsx`
- Modify: `apps/web/src/App.tsx` (execution page rendering)
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Create ExecutionFilterBar**

```typescript
// apps/web/src/components/executions/ExecutionFilterBar.tsx
import { useState } from "react";
import type { Agent, Project, ExecutionFilterValues } from "../../lib/types.js";

interface ExecutionFilterBarProps {
  agents: Agent[];
  projects: Project[];
  currentFilters: ExecutionFilterValues;
  onChange: (filters: ExecutionFilterValues) => void;
}

export function ExecutionFilterBar({ agents, projects, currentFilters, onChange }: ExecutionFilterBarProps) {
  const [filters, setFilters] = useState<ExecutionFilterValues>(currentFilters);

  const update = (patch: Partial<ExecutionFilterValues>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    onChange(next);
  };

  const reset = () => {
    setFilters({});
    onChange({});
  };

  const activeCount = Object.values(filters).filter(v => v !== undefined && v !== "" && (Array.isArray(v) ? v.length > 0 : true)).length;

  return (
    <div className="execution-filter-bar">
      <div className="execution-filter-bar__row">
        <select value={filters.projectId ?? ""} onChange={e => update({ projectId: e.target.value || undefined })}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        <select value={filters.agentId ?? ""} onChange={e => update({ agentId: e.target.value || undefined })}>
          <option value="">All Agents</option>
          {agents.filter(a => !filters.projectId || a.projectId === filters.projectId).map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
        </select>
        <div className="execution-filter-bar__statuses">
          {["queued", "running", "success", "failed", "timeout", "cancelled"].map(s => (
            <label key={s} className="execution-filter-bar__checkbox">
              <input
                type="checkbox"
                checked={filters.statuses?.includes(s) ?? false}
                onChange={e => {
                  const next = filters.statuses ? [...filters.statuses] : [];
                  if (e.target.checked) { next.push(s); } else { next.splice(next.indexOf(s), 1); }
                  update({ statuses: next.length > 0 ? next : undefined });
                }}
              />
              {s}
            </label>
          ))}
        </div>
        <select value={filters.triggerType ?? ""} onChange={e => update({ triggerType: e.target.value || undefined })}>
          <option value="">All Triggers</option>
          <option value="cron">cron</option>
          <option value="manual">manual</option>
          <option value="api">api</option>
          <option value="agent">agent</option>
          <option value="retry">retry</option>
        </select>
        <input
          type="text"
          placeholder="Search..."
          value={filters.search ?? ""}
          onChange={e => update({ search: e.target.value || undefined })}
        />
        {activeCount > 0 ? <button onClick={reset}>Reset ({activeCount})</button> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create ExecutionPagination**

```typescript
// apps/web/src/components/executions/ExecutionPagination.tsx

interface ExecutionPaginationProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (limit: number, offset: number) => void;
  pageSizeOptions?: number[];
}

export function ExecutionPagination({ total, limit, offset, onChange, pageSizeOptions = [25, 50, 100, 200] }: ExecutionPaginationProps) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const pages: number[] = [];
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    pages.push(i);
  }

  return (
    <div className="execution-pagination">
      <div className="execution-pagination__info">
        Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </div>
      <div className="execution-pagination__controls">
        <select value={limit} onChange={e => onChange(Number(e.target.value), 0)}>
          {pageSizeOptions.map(n => <option key={n} value={n}>{n} per page</option>)}
        </select>
        <button disabled={offset === 0} onClick={() => onChange(limit, Math.max(0, offset - limit))}>← Prev</button>
        {pages[0] > 1 ? <><button onClick={() => onChange(limit, 0)}>1</button><span>…</span></> : null}
        {pages.map(p => (
          <button key={p} className={p === currentPage ? "active" : ""} onClick={() => onChange(limit, (p - 1) * limit)}>{p}</button>
        ))}
        {pages[pages.length - 1] < totalPages ? <><span>…</span><button onClick={() => onChange(limit, (totalPages - 1) * limit)}>{totalPages}</button></> : null}
        <button disabled={offset + limit >= total} onClick={() => onChange(limit, offset + limit)}>Next →</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update fetchExecutions in api.ts to support new params + return total**

```typescript
export async function fetchExecutions(params?: ExecutionFilterValues): Promise<{ executions: Execution[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.projectId) searchParams.set("project", params.projectId);
  if (params?.agentId) searchParams.set("agent_id", params.agentId);
  if (params?.statuses?.length) searchParams.set("status", params.statuses.join(","));
  if (params?.triggerType) searchParams.set("trigger_type", params.triggerType);
  if (params?.since) searchParams.set("since", params.since);
  if (params?.until) searchParams.set("until", params.until);
  if (params?.search) searchParams.set("search", params.search);
  searchParams.set("limit", String(params?.limit ?? 50));
  searchParams.set("offset", String(params?.offset ?? 0));

  const res = await fetch(`${BASE}/api/executions?${searchParams}`, { headers: authHeaders() });
  return res.json();
}
```

- [ ] **Step 4: Type-check + build**

```bash
cd apps/web && npx tsc --noEmit && npx vite build
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/executions/ apps/web/src/lib/api.ts
git commit -m "feat: execution filter bar, pagination, and expanded API params"
```

---

## Phase 3 — Overview Page Upgrade (P1)

### Task 3.1: Add 24h throughput chart and expanded stat cards

**Files:**
- Create: `apps/web/src/components/ui/Sparkline.tsx`
- Modify: `apps/web/src/App.tsx:3135-3189` (overview page)
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Create Sparkline component**

```typescript
// apps/web/src/components/ui/Sparkline.tsx
import { useMemo } from "react";

interface Bucket {
  hour: string;
  success?: number;
  failed?: number;
  timeout?: number;
  cancelled?: number;
  running?: number;
  queued?: number;
}

interface SparklineProps {
  data: Bucket[];
  width?: number;
  height?: number;
}

const STATUS_COLORS: Record<string, string> = {
  success: "#22c55e",
  failed: "#ef4444",
  timeout: "#f59e0b",
  cancelled: "#64748b",
  running: "#3b82f6",
  queued: "#94a3b8",
};

export function Sparkline({ data, width = 600, height = 160 }: SparklineProps) {
  const maxVal = useMemo(() => {
    let m = 1;
    for (const b of data) {
      const sum = (b.success ?? 0) + (b.failed ?? 0) + (b.timeout ?? 0) + (b.cancelled ?? 0) + (b.running ?? 0) + (b.queued ?? 0);
      if (sum > m) m = sum;
    }
    return m;
  }, [data]);

  if (!data.length) return <div className="text-muted">No data</div>;

  const barWidth = Math.max(4, (width - 40) / data.length - 2);
  const statuses = ["success", "failed", "timeout", "cancelled", "running", "queued"];

  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      {data.map((bucket, i) => {
        let yOffset = height - 20;
        const x = 30 + i * (barWidth + 2);
        let totalH = 0;
        for (const status of statuses) {
          const count = (bucket as any)[status] ?? 0;
          if (count === 0) continue;
          const h = Math.max(1, (count / maxVal) * (height - 30));
          totalH += h;
        }
        // Draw stacked bars bottom-up
        let currentY = height - 20;
        for (const status of statuses) {
          const count = (bucket as any)[status] ?? 0;
          if (count === 0) continue;
          const h = Math.max(1, (count / maxVal) * (height - 30));
          currentY -= h;
        }
        currentY = height - 20;
        return statuses.map(status => {
          const count = (bucket as any)[status] ?? 0;
          if (count === 0) return null;
          const h = Math.max(1, (count / maxVal) * (height - 30));
          const y = currentY - h;
          currentY = y;
          return <rect key={`${i}-${status}`} x={x} y={y} width={barWidth} height={h} fill={STATUS_COLORS[status] ?? "#94a3b8"} opacity={0.8} rx={1} />;
        });
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Add fetchThroughput to api.ts**

```typescript
export async function fetchThroughput(hours = 24): Promise<{ buckets: Array<{ hour: string } & Record<string, number>> }> {
  const res = await fetch(`${BASE}/api/stats/throughput?hours=${hours}`, { headers: authHeaders() });
  return res.json();
}
```

- [ ] **Step 3: Update overview page rendering**

Read the current overview section at App.tsx:3135-3189. Add Sparkline to the overview, expand stat cards to 8, add throughput chart and recent failures panel.

- [ ] **Step 4: Type-check + build**

```bash
cd apps/web && npx tsc --noEmit && npx vite build
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/Sparkline.tsx apps/web/src/lib/api.ts apps/web/src/App.tsx
git commit -m "feat: 24h throughput chart and expanded overview"
```

---

## Phase 4 — Agent Management Upgrade (P1)

### Task 4.1: Agent filter bar + bulk operations + toggle switch + health tiers

**Files:**
- Create: `apps/web/src/components/agents/AgentFilterBar.tsx`
- Create: `apps/web/src/components/agents/AgentBulkToolbar.tsx`
- Create: `apps/web/src/components/ui/Toggle.tsx`
- Modify: `apps/web/src/App.tsx` (agent page + AgentDirectoryPanel)

Implementation follows the same pattern as Phase 2/3 — create filter bar with search, project multi-select, type/status/schedule segmented buttons. Replace "Enable/Disable" text buttons with toggle switches. Add tri-tier health status (Online/Degraded/Offline with heartbeat age). Add checkbox column + bulk toolbar.

---

## Phase 5 — Project Selector + Multi-Project Scoping (P2)

### Task 5.1: Global project selector

**Files:**
- Create: `apps/web/src/components/layout/ProjectSelector.tsx`
- Create: `apps/web/src/context/DashboardContext.tsx`
- Modify: `apps/web/src/App.tsx` (sidebar + data loading)

Create project dropdown in sidebar. All API calls append `?project=<id>` when a project is selected. URL reflects scope. Settings page for project management (API keys, provider config, danger zone).

---

## Phase 6 — Scheduler + Alerts Pages (P2)

### Task 6.1: Scheduler page

**Files:**
- Create: `apps/web/src/components/scheduler/SchedulerHealthCard.tsx`
- Create: `apps/web/src/components/scheduler/CronOverview.tsx`
- Create: `apps/web/src/pages/SchedulerPage.tsx`
- Modify: `apps/web/src/App.tsx` (add page to navigation)

Current scheduler data already available via `/api/scheduler/status` and `/api/metrics`. Scheduler health card shows: running/stopped, tick count, overlap/lock skips, last tick duration, step-by-step health, leader status, global pause/resume buttons. Cron overview table shows all cron agents with expandable rows showing status dot timeline, next run, misfire badge, "Fire Now" button.

### Task 6.2: Alerts page

**Files:**
- Create: `apps/web/src/components/alerts/AlertFilterBar.tsx`
- Create: `apps/web/src/components/alerts/AlertDetailPanel.tsx`
- Create: `apps/web/src/pages/AlertsPage.tsx`
- Modify: `apps/web/src/App.tsx` (add page to navigation)

Current alert data available via `/api/alerts`. Rebuild as full page with stat strip, filter bar, paginated table, inline detail panel, bulk acknowledge.

---

## Phase 7 — Architecture Refactor (P3)

### Task 7.1: Context + useReducer

**Files:**
- Modify: `apps/web/src/context/DashboardContext.tsx`
- Create: `apps/web/src/context/DataContext.tsx`
- Modify: `apps/web/src/App.tsx`

Replace 35 `useState` hooks with two contexts:
- `DashboardContext` — UI state (page, projectScope, language, socketStatus)
- `DataContext` — server data (agents, executions, stats, alerts, schedulerStatus)

Each context uses `useReducer` with typed actions. Components consume via `useContext`.

### Task 7.2: Smart WebSocket routing

**Files:**
- Create: `apps/web/src/hooks/useWebSocket.ts`
- Modify: `apps/web/src/App.tsx`

Replace `onmessage → loadData(true)` with event-type dispatch. Each event type updates only the relevant slice of state. 10s polling kept as safety net.

### Task 7.3: File split

**Files:**
- Create: `apps/web/src/pages/OverviewPage.tsx`
- Create: `apps/web/src/pages/AgentsPage.tsx`
- Create: `apps/web/src/pages/ExecutionsPage.tsx`
- Create: `apps/web/src/pages/AgentDetailPage.tsx`
- Create: `apps/web/src/pages/ExecutionDetailPage.tsx`
- Modify: `apps/web/src/App.tsx` (strip to ~200 lines: providers + layout shell + routing)

Move each page's render block out of App.tsx into dedicated page components. Extract reusable components into `components/ui/`, `components/layout/`. Extract hooks into `hooks/`.

---

## Verification

After each phase, run:

```bash
# Server
cd apps/server && npx tsc --noEmit && npx vitest run

# Web
cd apps/web && npx tsc --noEmit && npx vite build

# Full deploy test
# Trigger a sweep execution and verify traces display in new chat view
# Verify execution filters, pagination, and real-time WebSocket updates
# Verify multi-project scoping isolates data correctly
```

---

## Dependency Graph

```
Phase 0.1 (types) ──────┬── Phase 0.2 (i18n) ────── Phase 1 (trace viewer)
                        │                           
                        ├── Phase 2 (execution history)
                        │                           
                        ├── Phase 3 (overview)
                        │                           
                        ├── Phase 4 (agent management)
                        │                           
                        ├── Phase 5 (project selector)
                        │                           
                        ├── Phase 6 (scheduler + alerts)
                        │                           
                        └── Phase 7 (architecture refactor)
```

Phases 1-2 (P0) are independent after Phase 0.1. Phases 3-4 (P1) are independent. Phase 5 (P2) depends on Phase 0 complete. Phase 7 (P3) runs last.
