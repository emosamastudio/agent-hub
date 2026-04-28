import path from "node:path";

import {
  deriveProjectDescriptorId,
  deriveSessionDescriptorId,
} from "../shared-types.js";
import type {
  AgentDescriptor,
  AgentEvent,
  AgentRun,
  WaitingReason,
} from "../shared-types.js";
import type { SqliteDatabase } from "./index.js";

interface SeedOptions {
  workspaceRoot: string;
}

interface InboxSeed {
  id: string;
  runId: string;
  agentId: string;
  reason: WaitingReason;
  createdAt: string;
  updatedAt: string;
}

interface RunSeedParams {
  id: string;
  agentId: string;
  title: string;
  state: AgentRun["state"];
  health: AgentRun["health"];
  attention: AgentRun["attention"];
  waitingReason: AgentRun["waitingReason"];
  progressPhase: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
  lastEventAt: string;
  createdAt: string;
}

export const SEEDED_DEMO_AGENT_IDS = [
  "agent-claude-code",
  "agent-openclaw",
  "agent-copilot-cli",
] as const;

function toRunSeedParams(run: AgentRun): RunSeedParams {
  return {
    id: run.id,
    agentId: run.agentId,
    title: run.title,
    state: run.state,
    health: run.health,
    attention: run.attention,
    waitingReason: run.waitingReason,
    progressPhase: run.progress?.phase ?? null,
    progressPercent: run.progress?.percent ?? null,
    progressMessage: run.progress?.message ?? null,
    lastEventAt: run.lastEventAt,
    createdAt: run.createdAt,
  };
}

function createSeedEvent(
  agent: AgentDescriptor,
  input: Omit<
    AgentEvent,
    "agentId" | "sessionKey" | "projectId" | "sourceEventId" | "correlationId"
  >,
): AgentEvent {
  return {
    ...input,
    agentId: agent.id,
    sessionKey: deriveSessionDescriptorId(agent.id),
    projectId: deriveProjectDescriptorId(agent.workspacePath, agent.id),
    sourceEventId: null,
    correlationId: null,
  };
}

export function seedDatabase(db: SqliteDatabase, options: SeedOptions): void {
  const existing = db
    .prepare<unknown[], { count: number }>("SELECT COUNT(*) AS count FROM agents")
    .get();

  if ((existing?.count ?? 0) > 0) {
    return;
  }

  const now = Date.now();
  const minutesAgo = (value: number): string =>
    new Date(now - value * 60_000).toISOString();

  const workspaceRoot = options.workspaceRoot;
  const claudeRunId = "run-claude-migration-review";
  const openclawRunId = "run-openclaw-indexer-rollup";
  const copilotRunId = "run-copilot-release-hotfix";
  const docsRunId = "run-copilot-doc-refresh";

  const agents: AgentDescriptor[] = [
    {
      id: "agent-claude-code",
      name: "Claude Code",
      platform: "claude-code",
      workspacePath: path.join(workspaceRoot, "agent-hub"),
      state: "waiting_input",
      health: "healthy",
      attention: "action_needed",
      lastHeartbeatAt: minutesAgo(2),
      lastEventAt: minutesAgo(2),
      currentRunId: claudeRunId,
    },
    {
      id: "agent-openclaw",
      name: "OpenClaw",
      platform: "openclaw",
      workspacePath: path.join(workspaceRoot, "openclaw"),
      state: "running",
      health: "healthy",
      attention: "info",
      lastHeartbeatAt: minutesAgo(1),
      lastEventAt: minutesAgo(1),
      currentRunId: openclawRunId,
    },
    {
      id: "agent-copilot-cli",
      name: "Copilot CLI",
      platform: "copilot-cli",
      workspacePath: path.join(workspaceRoot, "x402-gateway"),
      state: "paused",
      health: "degraded",
      attention: "action_needed",
      lastHeartbeatAt: minutesAgo(5),
      lastEventAt: minutesAgo(4),
      currentRunId: copilotRunId,
    },
  ];
  const agentById = new Map(agents.map((agent) => [agent.id, agent] as const));

  const runs: AgentRun[] = [
    {
      id: claudeRunId,
      agentId: "agent-claude-code",
      title: "Review DB migration for local event replay",
      state: "waiting_input",
      health: "healthy",
      attention: "action_needed",
      waitingReason: "approval",
      progress: {
        phase: "reviewing changeset",
        percent: 67,
        message: "Waiting for approval before applying the migration plan.",
      },
      lastEventAt: minutesAgo(2),
      createdAt: minutesAgo(18),
    },
    {
      id: openclawRunId,
      agentId: "agent-openclaw",
      title: "Index local chain activity into the mock timeline",
      state: "running",
      health: "healthy",
      attention: "info",
      waitingReason: null,
      progress: {
        phase: "indexing blocks",
        percent: 54,
        message: "Streaming local block deltas into the control-plane cache.",
      },
      lastEventAt: minutesAgo(1),
      createdAt: minutesAgo(26),
    },
    {
      id: copilotRunId,
      agentId: "agent-copilot-cli",
      title: "Patch release hotfix after smoke-test warning",
      state: "paused",
      health: "degraded",
      attention: "action_needed",
      waitingReason: "human_review",
      progress: {
        phase: "verifying smoke tests",
        percent: 82,
        message: "Paused for a human review after a flaky endpoint check.",
      },
      lastEventAt: minutesAgo(4),
      createdAt: minutesAgo(31),
    },
    {
      id: docsRunId,
      agentId: "agent-copilot-cli",
      title: "Refresh onboarding docs for local CLI runners",
      state: "completed",
      health: "healthy",
      attention: "silent",
      waitingReason: null,
      progress: {
        phase: "done",
        percent: 100,
        message: "Merged the refreshed docs into the local knowledge set.",
      },
      lastEventAt: minutesAgo(23),
      createdAt: minutesAgo(41),
    },
  ];

  const inboxEntries: InboxSeed[] = [
    {
      id: "inbox-claude-migration-review",
      runId: claudeRunId,
      agentId: "agent-claude-code",
      reason: "approval",
      createdAt: minutesAgo(3),
      updatedAt: minutesAgo(2),
    },
    {
      id: "inbox-copilot-release-hotfix",
      runId: copilotRunId,
      agentId: "agent-copilot-cli",
      reason: "human_review",
      createdAt: minutesAgo(6),
      updatedAt: minutesAgo(4),
    },
  ];

  const events: AgentEvent[] = [
    createSeedEvent(agentById.get("agent-claude-code")!, {
      id: "event-session-opened-claude",
      runId: claudeRunId,
      type: "session.opened",
      state: "starting",
      attention: "info",
      message: "Claude Code session bootstrapped against the local Agent Hub.",
      createdAt: minutesAgo(18),
    }),
    createSeedEvent(agentById.get("agent-openclaw")!, {
      id: "event-run-started-openclaw",
      runId: openclawRunId,
      type: "run.started",
      state: "running",
      attention: "info",
      message: "OpenClaw started indexing local chain activity.",
      createdAt: minutesAgo(25),
    }),
    createSeedEvent(agentById.get("agent-openclaw")!, {
      id: "event-run-progress-openclaw",
      runId: openclawRunId,
      type: "run.progress",
      state: "running",
      attention: "info",
      message: "Indexed 54% of the cached local chain history.",
      createdAt: minutesAgo(6),
    }),
    createSeedEvent(agentById.get("agent-openclaw")!, {
      id: "event-run-output-openclaw",
      runId: openclawRunId,
      type: "run.output",
      state: "running",
      attention: "info",
      message: "Detected a backlog spike while replaying mempool deltas.",
      createdAt: minutesAgo(3),
    }),
    createSeedEvent(agentById.get("agent-claude-code")!, {
      id: "event-run-approval-claude",
      runId: claudeRunId,
      type: "run.approval_required",
      state: "waiting_input",
      attention: "action_needed",
      message: "Claude Code is waiting for approval on the migration plan.",
      createdAt: minutesAgo(2),
    }),
    createSeedEvent(agentById.get("agent-copilot-cli")!, {
      id: "event-run-paused-copilot",
      runId: copilotRunId,
      type: "run.paused",
      state: "paused",
      attention: "action_needed",
      message: "Copilot CLI paused after a smoke-test warning on /release.",
      createdAt: minutesAgo(4),
    }),
    createSeedEvent(agentById.get("agent-copilot-cli")!, {
      id: "event-run-completed-docs",
      runId: docsRunId,
      type: "run.completed",
      state: "completed",
      attention: "silent",
      message: "Copilot CLI finished refreshing the onboarding docs.",
      createdAt: minutesAgo(23),
    }),
    createSeedEvent(agentById.get("agent-openclaw")!, {
      id: "event-agent-heartbeat-openclaw",
      runId: openclawRunId,
      type: "agent.heartbeat",
      state: "running",
      attention: "info",
      message: "OpenClaw heartbeat received from the local indexer loop.",
      createdAt: minutesAgo(1),
    }),
  ];

  const insertAgent = db.prepare<AgentDescriptor>(`
    INSERT INTO agents (
      id,
      name,
      platform,
      workspace_path,
      state,
      health,
      attention,
      last_heartbeat_at,
      last_event_at,
      current_run_id
    ) VALUES (
      @id,
      @name,
      @platform,
      @workspacePath,
      @state,
      @health,
      @attention,
      @lastHeartbeatAt,
      @lastEventAt,
      @currentRunId
    )
  `);

  const insertRun = db.prepare<RunSeedParams>(`
    INSERT INTO runs (
      id,
      agent_id,
      title,
      state,
      health,
      attention,
      waiting_reason,
      progress_phase,
      progress_percent,
      progress_message,
      last_event_at,
      created_at
    ) VALUES (
      @id,
      @agentId,
      @title,
      @state,
      @health,
      @attention,
      @waitingReason,
      @progressPhase,
      @progressPercent,
      @progressMessage,
      @lastEventAt,
      @createdAt
    )
  `);

  const insertInbox = db.prepare<InboxSeed>(`
    INSERT INTO inbox_entries (
      id,
      run_id,
      agent_id,
      reason,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @runId,
      @agentId,
      @reason,
      @createdAt,
      @updatedAt
    )
  `);

  const insertEvent = db.prepare<AgentEvent>(`
    INSERT INTO events (
      id,
      run_id,
      agent_id,
      session_key,
      project_id,
      source_event_id,
      correlation_id,
      type,
      state,
      attention,
      message,
      created_at
    ) VALUES (
      @id,
      @runId,
      @agentId,
      @sessionKey,
      @projectId,
      @sourceEventId,
      @correlationId,
      @type,
      @state,
      @attention,
      @message,
      @createdAt
    )
  `);

  db.transaction(() => {
    for (const agent of agents) {
      insertAgent.run(agent);
    }

    for (const run of runs) {
      insertRun.run(toRunSeedParams(run));
    }

    for (const entry of inboxEntries) {
      insertInbox.run(entry);
    }

    for (const event of events) {
      insertEvent.run(event);
    }
  })();
}
