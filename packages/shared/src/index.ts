export type AgentPlatform =
  | "claude-code"
  | "copilot-cli"
  | "gemini-cli"
  | "openclaw"
  | "generic";

export type AgentHealth =
  | "healthy"
  | "degraded"
  | "stalled"
  | "rate_limited"
  | "auth_required"
  | "unavailable";

export type AgentAttention = "silent" | "info" | "action_needed" | "urgent";

export type RunState =
  | "discovered"
  | "ready"
  | "queued"
  | "starting"
  | "running"
  | "waiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "offline";

export type WaitingReason =
  | "approval"
  | "missing_context"
  | "tool_permission"
  | "login_required"
  | "human_review"
  | "unknown";

export type RunAction = "approve" | "pause" | "resume" | "cancel";

export type AgentSourceKind =
  | "seeded-demo"
  | "copilot-session-state"
  | "claude-project-logs"
  | "gemini-project-chats"
  | "openclaw-status-cli"
  | "external-ingest"
  | "live-adapter";

export type RunActionSupportCode =
  | "mock-runtime"
  | "copilot-discovery-readonly"
  | "claude-discovery-readonly"
  | "gemini-discovery-readonly"
  | "openclaw-discovery-readonly"
  | "external-ingest-readonly"
  | "live-adapter-readonly"
  | "agent-missing";

export interface RunActionSupport {
  supported: boolean;
  code: RunActionSupportCode;
}

export interface AgentSessionMetadata {
  sessionId?: string | null;
  sessionKey?: string | null;
  sessionPath?: string | null;
  gitRoot?: string | null;
  branch?: string | null;
  summary?: string | null;
  summaryCount?: number | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  toolVersion?: string | null;
  remoteSteerable?: boolean | null;
  alreadyInUse?: boolean | null;
  gatewayUrl?: string | null;
  gatewayReachable?: boolean | null;
  gatewayError?: string | null;
  gatewayServiceInstalled?: boolean | null;
  gatewayServiceLoaded?: boolean | null;
  gatewayServiceLoadedText?: string | null;
  runtimeActionEndpoint?: string | null;
  runtimeActionTargets?: AgentRuntimeActionTarget[] | null;
  upstreamApprovalSupport?: UpstreamApprovalSupport | null;
}

export type UpstreamApprovalSupportCode =
  | "openclaw-acp-session"
  | "openclaw-session-not-acp"
  | "openclaw-session-unavailable";

export interface UpstreamApprovalSupport {
  supported: boolean;
  code: UpstreamApprovalSupportCode;
}

export type ApprovalPlatform = "openclaw";

export type ApprovalState = "pending" | "resolved" | "expired" | "stale";

export type ApprovalDecision = "allow-once" | "deny";

export type ApprovalResolveSupportCode =
  | "openclaw-bridge-live"
  | "openclaw-bridge-disconnected"
  | "approval-not-pending";

export interface ApprovalResolveSupport {
  supported: boolean;
  code: ApprovalResolveSupportCode;
}

export interface ApprovalRequestPreview {
  command: string;
  commandArgv?: string[] | null;
  cwd?: string | null;
  host?: string | null;
  nodeId?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  envKeys?: string[] | null;
  systemRunPlan?: Record<string, unknown> | null;
  systemRunBinding?: Record<string, unknown> | null;
}

export interface ApprovalItem {
  id: string;
  platform: ApprovalPlatform;
  state: ApprovalState;
  attention: AgentAttention;
  agentId: string | null;
  runId: string | null;
  upstreamAgentId?: string | null;
  sessionKey?: string | null;
  host?: string | null;
  nodeId?: string | null;
  request: ApprovalRequestPreview;
  createdAt: string;
  expiresAt: string | null;
  observedAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  decision?: ApprovalDecision | null;
  bridgeSessionId?: string | null;
}

export interface ApprovalBridgeStatus {
  platform: ApprovalPlatform;
  connected: boolean;
  liveOnly: boolean;
  completeness: "live-only";
  observedSince: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  url: string | null;
}

export type AgentEventType =
  | "agent.registered"
  | "agent.heartbeat"
  | "session.opened"
  | "session.dispatch_text"
  | "task.priority_changed"
  | "task.assigned"
  | "task.handoff_requested"
  | "task.handoff_completed"
  | "task.handoff_cleared"
  | "task.unassigned"
  | "terminal.attach"
  | "runtime.action_acknowledged"
  | "run.queued"
  | "run.started"
  | "run.progress"
  | "run.output"
  | "run.waiting_input"
  | "run.approval_required"
  | "run.paused"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.stalled"
  | "run.resumed"
  | "approval.requested"
  | "approval.resolved"
  | "approval.expired"
  | "approval.bridge_disconnected"
  | "agent.offline"
  | "agent.recovered";

export interface AgentEventLineage {
  sessionKey: string | null;
  projectId: string | null;
  sourceEventId: string | null;
  correlationId: string | null;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  platform: AgentPlatform;
  workspacePath: string;
  state: RunState;
  health: AgentHealth;
  attention: AgentAttention;
  lastHeartbeatAt: string | null;
  lastEventAt: string | null;
  currentRunId: string | null;
  sessionMetadata?: AgentSessionMetadata | null;
  runtimeActionSupport?: Partial<
    Record<AgentRuntimeActionTarget, AgentRuntimeActionSupport>
  > | null;
}

export interface RunProgress {
  phase: string;
  percent: number | null;
  message: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  title: string;
  state: RunState;
  health: AgentHealth;
  attention: AgentAttention;
  waitingReason: WaitingReason | null;
  progress: RunProgress | null;
  lastEventAt: string;
  createdAt: string;
}

export interface AgentEvent extends AgentEventLineage {
  id: string;
  runId: string | null;
  agentId: string;
  type: AgentEventType;
  state: RunState | null;
  attention: AgentAttention;
  message: string;
  createdAt: string;
}

export interface ProjectDescriptor {
  id: string;
  name: string;
  workspacePath: string;
  gitRoot: string | null;
  attention: AgentAttention;
  health: AgentHealth;
  lastEventAt: string | null;
  agentCount: number;
  sessionCount: number;
  activeSessionCount: number;
  taskCount: number;
  activeTaskCount: number;
  waitingTaskCount: number;
  runtimePlatforms: AgentPlatform[];
}

export interface SessionDescriptor {
  id: string;
  agentId: string;
  projectId: string;
  name: string;
  platform: AgentPlatform;
  workspacePath: string;
  state: RunState;
  health: AgentHealth;
  attention: AgentAttention;
  currentRunId: string | null;
  lastHeartbeatAt: string | null;
  lastEventAt: string | null;
  sessionId: string | null;
  sessionPath: string | null;
  summary: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  activeTaskCount: number;
}

export type TaskPriority = "low" | "normal" | "high" | "critical";

export interface TaskDescriptor {
  id: string;
  runId: string;
  agentId: string;
  sessionKey: string;
  projectId: string;
  title: string;
  platform: AgentPlatform;
  workspacePath: string;
  state: RunState;
  health: AgentHealth;
  attention: AgentAttention;
  waitingReason: WaitingReason | null;
  progress: RunProgress | null;
  lastEventAt: string;
  createdAt: string;
  runtimeSessionId: string | null;
  sessionPath: string | null;
  summary: string;
  eventCount: number;
  priority: TaskPriority;
  priorityUpdatedAt: string | null;
  owner: string | null;
  assignedAt: string | null;
  assignmentUpdatedAt: string | null;
  handoffTarget: string | null;
  handoffNote: string | null;
  handoffRequestedAt: string | null;
  handoffUpdatedAt: string | null;
}

export interface TaskAssignmentState {
  runId: string;
  owner: string;
  assignedAt: string;
  updatedAt: string;
}

export interface TaskPriorityState {
  runId: string;
  priority: TaskPriority;
  updatedAt: string;
}

export interface TaskHandoffState {
  runId: string;
  targetOwner: string;
  note: string | null;
  requestedAt: string;
  updatedAt: string;
}

export type ResourcePressure =
  | "idle"
  | "available"
  | "saturated"
  | "overcommitted";

export interface ResourcePolicyState {
  platform: AgentPlatform;
  slotLimit: number;
  updatedAt: string;
}

export interface ResourceDescriptor {
  id: string;
  platform: AgentPlatform;
  sessionCount: number;
  projectCount: number;
  taskCount: number;
  activeTaskCount: number;
  waitingTaskCount: number;
  slotLimit: number | null;
  availableSlots: number | null;
  overCapacityTaskCount: number;
  utilizationPercent: number | null;
  pressure: ResourcePressure;
  attention: AgentAttention;
  health: AgentHealth;
  lastActivityAt: string | null;
  policyUpdatedAt: string | null;
}

export interface DashboardSnapshot {
  generatedAt: string;
  agents: AgentDescriptor[];
  runs: AgentRun[];
  inbox: AgentRun[];
  approvals: ApprovalItem[];
  approvalBridge?: Partial<Record<ApprovalPlatform, ApprovalBridgeStatus>> | null;
  events: AgentEvent[];
  projects: ProjectDescriptor[];
  sessions: SessionDescriptor[];
  tasks: TaskDescriptor[];
  resources: ResourceDescriptor[];
}

export function deriveOperationalTopology(input: {
  agents: AgentDescriptor[];
  runs: AgentRun[];
  events: AgentEvent[];
  taskPriorities?: TaskPriorityState[];
  taskAssignments?: TaskAssignmentState[];
  taskHandoffs?: TaskHandoffState[];
}): {
  projects: ProjectDescriptor[];
  sessions: SessionDescriptor[];
  tasks: TaskDescriptor[];
} {
  const agentById = new Map(input.agents.map((agent) => [agent.id, agent] as const));
  const taskPriorityByRunId = new Map(
    (input.taskPriorities ?? []).map((priority) => [priority.runId, priority] as const),
  );
  const taskAssignmentByRunId = new Map(
    (input.taskAssignments ?? []).map((assignment) => [assignment.runId, assignment] as const),
  );
  const taskHandoffByRunId = new Map(
    (input.taskHandoffs ?? []).map((handoff) => [handoff.runId, handoff] as const),
  );
  const runEventMeta = new Map<
    string,
    { count: number; lastMessage: string | null; lastEventAt: string | null }
  >();
  const activeTaskCountByAgent = new Map<string, number>();

  for (const event of input.events) {
    if (!event.runId) {
      continue;
    }

    const existing = runEventMeta.get(event.runId);
    if (!existing) {
      runEventMeta.set(event.runId, {
        count: 1,
        lastMessage: event.message,
        lastEventAt: event.createdAt,
      });
      continue;
    }

    const nextCount = existing.count + 1;
    if (timestampValue(event.createdAt) > timestampValue(existing.lastEventAt)) {
      runEventMeta.set(event.runId, {
        count: nextCount,
        lastMessage: event.message,
        lastEventAt: event.createdAt,
      });
      continue;
    }

    runEventMeta.set(event.runId, {
      ...existing,
      count: nextCount,
    });
  }

  for (const run of input.runs) {
    if (!isActiveTaskState(run.state)) {
      continue;
    }

    activeTaskCountByAgent.set(
      run.agentId,
      (activeTaskCountByAgent.get(run.agentId) ?? 0) + 1,
    );
  }

  const sessions = sortSessions(
    input.agents.map((agent) => {
      const projectId = buildProjectId(agent.workspacePath, agent.id);
      return {
        id: buildSessionKey(agent.id),
        agentId: agent.id,
        projectId,
        name: agent.name,
        platform: agent.platform,
        workspacePath: agent.workspacePath,
        state: agent.state,
        health: agent.health,
        attention: agent.attention,
        currentRunId: agent.currentRunId,
        lastHeartbeatAt: agent.lastHeartbeatAt,
        lastEventAt: agent.lastEventAt,
        sessionId: agent.sessionMetadata?.sessionId?.trim() ?? null,
        sessionPath: agent.sessionMetadata?.sessionPath?.trim() ?? null,
        summary: agent.sessionMetadata?.summary?.trim() ?? null,
        startedAt: agent.sessionMetadata?.startedAt ?? null,
        updatedAt: agent.sessionMetadata?.updatedAt ?? null,
        activeTaskCount: activeTaskCountByAgent.get(agent.id) ?? 0,
      } satisfies SessionDescriptor;
    }),
  );

  const tasks = sortTasks(
    input.runs.map((run) => {
      const agent = agentById.get(run.agentId);
      const workspacePath = agent?.workspacePath ?? "";
      const metadata = agent?.sessionMetadata ?? null;
      const eventMeta = runEventMeta.get(run.id);
      const priority = taskPriorityByRunId.get(run.id);
      const assignment = taskAssignmentByRunId.get(run.id);
      const handoff = taskHandoffByRunId.get(run.id);
      return {
        id: buildTaskId(run.id),
        runId: run.id,
        agentId: run.agentId,
        sessionKey: buildSessionKey(run.agentId),
        projectId: buildProjectId(workspacePath, run.agentId),
        title: run.title,
        platform: agent?.platform ?? "generic",
        workspacePath,
        state: run.state,
        health: run.health,
        attention: run.attention,
        waitingReason: run.waitingReason ?? null,
        progress: run.progress ?? null,
        lastEventAt: run.lastEventAt,
        createdAt: run.createdAt,
        runtimeSessionId: metadata?.sessionId?.trim() ?? null,
        sessionPath: metadata?.sessionPath?.trim() ?? null,
        summary:
          eventMeta?.lastMessage?.trim() ||
          run.progress?.message?.trim() ||
          metadata?.summary?.trim() ||
          run.title,
        eventCount: eventMeta?.count ?? 0,
        priority: priority?.priority ?? "normal",
        priorityUpdatedAt: priority?.updatedAt ?? null,
        owner: assignment?.owner?.trim() || null,
        assignedAt: assignment?.assignedAt ?? null,
        assignmentUpdatedAt: assignment?.updatedAt ?? null,
        handoffTarget: handoff?.targetOwner?.trim() || null,
        handoffNote: handoff?.note?.trim() || null,
        handoffRequestedAt: handoff?.requestedAt ?? null,
        handoffUpdatedAt: handoff?.updatedAt ?? null,
      } satisfies TaskDescriptor;
    }),
  );

  const projectMap = new Map<
    string,
    {
      id: string;
      name: string;
      workspacePath: string;
      gitRoot: string | null;
      attention: AgentAttention;
      health: AgentHealth;
      lastEventAt: string | null;
      sessionIds: Set<string>;
      activeSessionCount: number;
      taskCount: number;
      activeTaskCount: number;
      waitingTaskCount: number;
      runtimePlatforms: Set<AgentPlatform>;
    }
  >();

  for (const session of sessions) {
    const project = ensureProjectEntry(projectMap, session.projectId, session.workspacePath);
    project.sessionIds.add(session.id);
    if (isActiveTaskState(session.state)) {
      project.activeSessionCount += 1;
    }
    project.attention = mergeAttention(project.attention, session.attention);
    project.health = mergeHealth(project.health, session.health);
    project.lastEventAt = pickLaterTimestamp(project.lastEventAt, session.lastEventAt);
    project.runtimePlatforms.add(session.platform);
  }

  for (const task of tasks) {
    const project = ensureProjectEntry(projectMap, task.projectId, task.workspacePath);
    project.taskCount += 1;
    if (isActiveTaskState(task.state)) {
      project.activeTaskCount += 1;
    }
    if (task.waitingReason || task.state === "waiting_input" || task.state === "paused") {
      project.waitingTaskCount += 1;
    }
    project.attention = mergeAttention(project.attention, task.attention);
    project.health = mergeHealth(project.health, task.health);
    project.lastEventAt = pickLaterTimestamp(project.lastEventAt, task.lastEventAt);
    project.runtimePlatforms.add(task.platform);
  }

  const projects = sortProjects(
    [...projectMap.values()].map((project) => ({
      id: project.id,
      name: project.name,
      workspacePath: project.workspacePath,
      gitRoot: project.gitRoot,
      attention: project.attention,
      health: project.health,
      lastEventAt: project.lastEventAt,
      agentCount: project.sessionIds.size,
      sessionCount: project.sessionIds.size,
      activeSessionCount: project.activeSessionCount,
      taskCount: project.taskCount,
      activeTaskCount: project.activeTaskCount,
      waitingTaskCount: project.waitingTaskCount,
      runtimePlatforms: [...project.runtimePlatforms].sort((left, right) =>
        left.localeCompare(right),
      ),
    })),
  );

  return {
    projects,
    sessions,
    tasks,
  };
}

export function deriveResourceDescriptors(input: {
  sessions: SessionDescriptor[];
  tasks: TaskDescriptor[];
  resourcePolicies?: ResourcePolicyState[];
}): ResourceDescriptor[] {
  const resourcePolicyByPlatform = new Map(
    (input.resourcePolicies ?? []).map((policy) => [policy.platform, policy] as const),
  );
  const resourceMap = new Map<
    AgentPlatform,
    {
      id: string;
      platform: AgentPlatform;
      sessionCount: number;
      projectIds: Set<string>;
      taskCount: number;
      activeTaskCount: number;
      waitingTaskCount: number;
      attention: AgentAttention;
      health: AgentHealth;
      lastActivityAt: string | null;
    }
  >(
    RESOURCE_PLATFORMS.map((platform) => [
      platform,
      {
        id: buildResourceId(platform),
        platform,
        sessionCount: 0,
        projectIds: new Set<string>(),
        taskCount: 0,
        activeTaskCount: 0,
        waitingTaskCount: 0,
        attention: "silent" as const,
        health: "healthy" as const,
        lastActivityAt: null,
      },
    ]),
  );

  for (const session of input.sessions) {
    const resource = resourceMap.get(session.platform);
    if (!resource) {
      continue;
    }

    resource.sessionCount += 1;
    resource.projectIds.add(session.projectId);
    resource.attention = mergeAttention(resource.attention, session.attention);
    resource.health = mergeHealth(resource.health, session.health);
    resource.lastActivityAt = pickLaterTimestamp(
      resource.lastActivityAt,
      latestTimestamp(session.lastEventAt, session.updatedAt, session.startedAt),
    );
  }

  for (const task of input.tasks) {
    const resource = resourceMap.get(task.platform);
    if (!resource) {
      continue;
    }

    resource.taskCount += 1;
    resource.projectIds.add(task.projectId);
    if (isActiveTaskState(task.state)) {
      resource.activeTaskCount += 1;
    }
    if (task.waitingReason || task.state === "waiting_input" || task.state === "paused") {
      resource.waitingTaskCount += 1;
    }
    resource.attention = mergeAttention(resource.attention, task.attention);
    resource.health = mergeHealth(resource.health, task.health);
    resource.lastActivityAt = pickLaterTimestamp(
      resource.lastActivityAt,
      latestTimestamp(
        task.lastEventAt,
        task.assignmentUpdatedAt,
        task.handoffUpdatedAt,
        task.createdAt,
      ),
    );
  }

  return sortResources(
    [...resourceMap.values()].map((resource) => {
      const policy = resourcePolicyByPlatform.get(resource.platform);
      const slotLimit = policy?.slotLimit ?? null;
      const overCapacityTaskCount =
        slotLimit === null ? 0 : Math.max(resource.activeTaskCount - slotLimit, 0);
      const availableSlots =
        slotLimit === null ? null : Math.max(slotLimit - resource.activeTaskCount, 0);
      const utilizationPercent =
        slotLimit === null
          ? null
          : slotLimit === 0
            ? resource.activeTaskCount > 0 || resource.waitingTaskCount > 0
              ? 100
              : 0
            : Math.round((resource.activeTaskCount / slotLimit) * 100);
      const pressure =
        slotLimit === null
          ? resource.activeTaskCount === 0 && resource.waitingTaskCount === 0
            ? "idle"
            : "available"
          : overCapacityTaskCount > 0
            ? "overcommitted"
            : slotLimit === 0
              ? "idle"
              : resource.activeTaskCount >= slotLimit
                ? "saturated"
                : resource.activeTaskCount === 0 && resource.waitingTaskCount === 0
                  ? "idle"
                  : "available";

      return {
        id: resource.id,
        platform: resource.platform,
        sessionCount: resource.sessionCount,
        projectCount: resource.projectIds.size,
        taskCount: resource.taskCount,
        activeTaskCount: resource.activeTaskCount,
        waitingTaskCount: resource.waitingTaskCount,
        slotLimit,
        availableSlots,
        overCapacityTaskCount,
        utilizationPercent,
        pressure,
        attention: resource.attention,
        health: resource.health,
        lastActivityAt: resource.lastActivityAt,
        policyUpdatedAt: policy?.updatedAt ?? null,
      } satisfies ResourceDescriptor;
    }),
  );
}

export function deriveProjectDescriptorId(
  workspacePath: string,
  fallbackId: string,
): string {
  return buildProjectId(workspacePath, fallbackId);
}

export function deriveSessionDescriptorId(agentId: string): string {
  return buildSessionKey(agentId);
}

export interface AgentIngestAgentInput {
  id: string;
  name: string;
  platform: AgentPlatform;
  workspacePath: string;
  state: RunState;
  health: AgentHealth;
  attention: AgentAttention;
  lastHeartbeatAt?: string | null;
  lastEventAt?: string | null;
  currentRunId?: string | null;
  sessionMetadata?: AgentSessionMetadata | null;
}

export interface AgentIngestRunInput {
  id: string;
  agentId?: string;
  title: string;
  state: RunState;
  health: AgentHealth;
  attention: AgentAttention;
  waitingReason?: WaitingReason | null;
  progress?: RunProgress | null;
  lastEventAt?: string;
  createdAt?: string;
}

export interface AgentIngestEventInput {
  type: AgentEventType;
  runId?: string | null;
  state?: RunState | null;
  attention?: AgentAttention;
  message: string;
  sourceEventId?: string | null;
  correlationId?: string | null;
  createdAt?: string;
}

export interface AgentIngestPayload {
  agent: AgentIngestAgentInput;
  run?: AgentIngestRunInput;
  event?: AgentIngestEventInput;
}

export interface AgentIngestResult {
  ok: true;
  agent: AgentDescriptor;
  run: AgentRun | null;
  event: AgentEvent | null;
  snapshot: DashboardSnapshot;
}

export type AgentWorkspaceActionTarget =
  | "finder"
  | "terminal"
  | "session_state"
  | "runtime_home";

export interface AgentWorkspaceActionRequest {
  target: AgentWorkspaceActionTarget;
}

export interface AgentWorkspaceActionResult {
  ok: true;
  agentId: string;
  target: AgentWorkspaceActionTarget;
  openedPath: string;
  message: string;
}

export type AgentRuntimeActionTarget =
  | "recover_gateway"
  | "reset_session"
  | "send_prompt";

export interface AgentRuntimeActionRequest {
  target: AgentRuntimeActionTarget;
  message?: string;
}

export interface AgentRuntimeActionResult {
  ok: true;
  agentId: string;
  target: AgentRuntimeActionTarget;
  message: string;
  snapshot?: DashboardSnapshot;
  runId?: string | null;
  sessionId?: string | null;
  event?: AgentEvent | null;
}

export type SessionActionTarget = "dispatch_text" | "attach_terminal";

export interface SessionActionRequest {
  target: SessionActionTarget;
  message?: string;
}

export interface SessionActionResult {
  ok: true;
  sessionId: string;
  agentId: string;
  target: SessionActionTarget;
  message: string;
  runId?: string | null;
  openedPath?: string | null;
  launchCommand?: string | null;
  snapshot?: DashboardSnapshot;
  event?: AgentEvent | null;
}

export type SessionTerminalAttachSupportCode =
  | "session-missing"
  | "session-id-missing"
  | "claude-resume-terminal"
  | "gemini-resume-terminal"
  | "session-attach-unsupported-runtime";

export interface SessionTerminalAttachSupport {
  supported: boolean;
  code: SessionTerminalAttachSupportCode;
}

export interface TaskAssignmentRequest {
  owner: string | null;
}

export interface TaskPriorityRequest {
  priority: TaskPriority;
}

export interface TaskPriorityResult {
  ok: true;
  taskId: string;
  runId: string;
  priority: TaskPriority;
  message: string;
  snapshot?: DashboardSnapshot;
  event?: AgentEvent | null;
}

export interface TaskAssignmentResult {
  ok: true;
  taskId: string;
  runId: string;
  owner: string | null;
  message: string;
  snapshot?: DashboardSnapshot;
  event?: AgentEvent | null;
}

export interface TaskHandoffRequest {
  targetOwner: string | null;
  note?: string | null;
}

export interface TaskHandoffResult {
  ok: true;
  taskId: string;
  runId: string;
  owner: string | null;
  targetOwner: string | null;
  note: string | null;
  message: string;
  snapshot?: DashboardSnapshot;
  event?: AgentEvent | null;
}

export interface TaskHandoffActionRequest {
  action: "complete";
}

export interface ResourcePolicyUpdateRequest {
  slotLimit: number | null;
}

export interface ResourcePolicyUpdateResult {
  ok: true;
  resourceId: string;
  platform: AgentPlatform;
  slotLimit: number | null;
  message: string;
  resource: ResourceDescriptor;
  snapshot?: DashboardSnapshot;
}

export type AgentRuntimeActionSupportCode =
  | "claude-prompt-dispatch"
  | "claude-prompt-unavailable"
  | "claude-auth-required"
  | "gemini-prompt-dispatch"
  | "gemini-prompt-unavailable"
  | "gemini-auth-required"
  | "sidecar-prompt-dispatch"
  | "sidecar-prompt-unavailable"
  | "openclaw-gateway-recovery"
  | "openclaw-session-reset"
  | "openclaw-prompt-dispatch"
  | "openclaw-gateway-healthy"
  | "openclaw-session-unavailable"
  | "openclaw-prompt-unavailable"
  | "copilot-prompt-dispatch"
  | "copilot-prompt-unavailable"
  | "unsupported-runtime"
  | "agent-missing";

export interface AgentRuntimeActionSupport {
  supported: boolean;
  code: AgentRuntimeActionSupportCode;
}

export type ReferenceProjectCategory =
  | "agent-workbench"
  | "workflow-builder"
  | "observability";

export interface ReferenceProject {
  id: string;
  name: string;
  repoUrl: string;
  stars: number;
  language: string;
  category: ReferenceProjectCategory;
  summary: string;
  reuseInsteadOfBuilding: string;
  hubIntegration: string;
}

export interface HubHealth {
  ok: true;
  generatedAt: string;
  mockRuntimeEnabled: boolean;
  copilotSessionDiscoveryEnabled: boolean;
  claudeCodeSessionDiscoveryEnabled: boolean;
  geminiCliSessionDiscoveryEnabled: boolean;
  openClawSessionDiscoveryEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  desktopNotificationsSupported: boolean;
  counts: {
    agents: number;
    runs: number;
    inbox: number;
    approvals: number;
    events: number;
  };
}

const ACTIVE_TASK_RUN_STATES = new Set<RunState>([
  "ready",
  "queued",
  "starting",
  "running",
  "waiting_input",
  "paused",
]);
const RESOURCE_PLATFORMS: readonly AgentPlatform[] = [
  "claude-code",
  "copilot-cli",
  "gemini-cli",
  "openclaw",
  "generic",
];
const TERMINAL_RUN_STATES = new Set<RunState>([
  "completed",
  "failed",
  "cancelled",
  "offline",
]);

const SEEDED_DEMO_AGENT_IDS = new Set<AgentDescriptor["id"]>([
  "agent-claude-code",
  "agent-openclaw",
  "agent-copilot-cli",
]);

const RESUMABLE_WAITING_REASONS = new Set<WaitingReason>([
  "approval",
  "human_review",
  "tool_permission",
  "missing_context",
  "unknown",
]);

const LOOPBACK_RUNTIME_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SESSION_STATE_SOURCE_KINDS = new Set<AgentSourceKind>([
  "copilot-session-state",
  "claude-project-logs",
  "gemini-project-chats",
]);
const RUNTIME_HOME_PLATFORMS = new Set<AgentPlatform>([
  "claude-code",
  "copilot-cli",
  "gemini-cli",
  "openclaw",
]);

function buildProjectId(workspacePath: string, fallbackId: string): string {
  const normalizedPath = workspacePath.trim();
  return normalizedPath.length > 0
    ? `project:${normalizedPath}`
    : `project:agent:${fallbackId}`;
}

function buildSessionKey(agentId: string): string {
  return `session:${agentId}`;
}

function buildTaskId(runId: string): string {
  return `task:${runId}`;
}

function buildResourceId(platform: AgentPlatform): string {
  return `resource:platform:${platform}`;
}

function ensureProjectEntry(
  projectMap: Map<
    string,
    {
      id: string;
      name: string;
      workspacePath: string;
      gitRoot: string | null;
      attention: AgentAttention;
      health: AgentHealth;
      lastEventAt: string | null;
      sessionIds: Set<string>;
      activeSessionCount: number;
      taskCount: number;
      activeTaskCount: number;
      waitingTaskCount: number;
      runtimePlatforms: Set<AgentPlatform>;
    }
  >,
  projectId: string,
  workspacePath: string,
) {
  const existing = projectMap.get(projectId);
  if (existing) {
    return existing;
  }

  const nextEntry = {
    id: projectId,
    name: getWorkspaceName(workspacePath),
    workspacePath,
    gitRoot: workspacePath.trim() || null,
    attention: "silent" as const,
    health: "healthy" as const,
    lastEventAt: null,
    sessionIds: new Set<string>(),
    activeSessionCount: 0,
    taskCount: 0,
    activeTaskCount: 0,
    waitingTaskCount: 0,
    runtimePlatforms: new Set<AgentPlatform>(),
  };
  projectMap.set(projectId, nextEntry);
  return nextEntry;
}

function getWorkspaceName(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/, "").trim();
  if (!normalized) {
    return "Unknown workspace";
  }

  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}

function sortProjects(projects: ProjectDescriptor[]): ProjectDescriptor[] {
  return [...projects].sort(
    (left, right) =>
      attentionWeight(right.attention) - attentionWeight(left.attention) ||
      healthWeight(right.health) - healthWeight(left.health) ||
      right.activeTaskCount - left.activeTaskCount ||
      timestampValue(right.lastEventAt) - timestampValue(left.lastEventAt) ||
      left.name.localeCompare(right.name),
  );
}

function sortSessions(sessions: SessionDescriptor[]): SessionDescriptor[] {
  return [...sessions].sort(
    (left, right) =>
      attentionWeight(right.attention) - attentionWeight(left.attention) ||
      healthWeight(right.health) - healthWeight(left.health) ||
      timestampValue(right.lastEventAt) - timestampValue(left.lastEventAt) ||
      left.name.localeCompare(right.name),
  );
}

function sortTasks(tasks: TaskDescriptor[]): TaskDescriptor[] {
  return [...tasks].sort(
    (left, right) =>
      taskPriorityWeight(right.priority) - taskPriorityWeight(left.priority) ||
      attentionWeight(right.attention) - attentionWeight(left.attention) ||
      healthWeight(right.health) - healthWeight(left.health) ||
      timestampValue(right.lastEventAt) - timestampValue(left.lastEventAt) ||
      timestampValue(right.createdAt) - timestampValue(left.createdAt),
  );
}

function sortResources(resources: ResourceDescriptor[]): ResourceDescriptor[] {
  return [...resources].sort(
    (left, right) =>
      resourcePressureWeight(right.pressure) - resourcePressureWeight(left.pressure) ||
      attentionWeight(right.attention) - attentionWeight(left.attention) ||
      healthWeight(right.health) - healthWeight(left.health) ||
      right.activeTaskCount - left.activeTaskCount ||
      right.waitingTaskCount - left.waitingTaskCount ||
      left.platform.localeCompare(right.platform),
  );
}

function isActiveTaskState(state: RunState): boolean {
  return ACTIVE_TASK_RUN_STATES.has(state);
}

function resourcePressureWeight(pressure: ResourcePressure): number {
  switch (pressure) {
    case "overcommitted":
      return 3;
    case "saturated":
      return 2;
    case "available":
      return 1;
    default:
      return 0;
  }
}

function taskPriorityWeight(priority: TaskPriority): number {
  switch (priority) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "normal":
      return 1;
    default:
      return 0;
  }
}

function attentionWeight(attention: AgentAttention): number {
  switch (attention) {
    case "urgent":
      return 3;
    case "action_needed":
      return 2;
    case "info":
      return 1;
    default:
      return 0;
  }
}

function healthWeight(health: AgentHealth): number {
  switch (health) {
    case "unavailable":
      return 5;
    case "auth_required":
      return 4;
    case "stalled":
      return 3;
    case "rate_limited":
      return 2;
    case "degraded":
      return 1;
    default:
      return 0;
  }
}

function mergeAttention(
  current: AgentAttention,
  candidate: AgentAttention,
): AgentAttention {
  return attentionWeight(candidate) > attentionWeight(current) ? candidate : current;
}

function mergeHealth(current: AgentHealth, candidate: AgentHealth): AgentHealth {
  return healthWeight(candidate) > healthWeight(current) ? candidate : current;
}

function pickLaterTimestamp(
  current: string | null,
  candidate: string | null,
): string | null {
  return timestampValue(candidate) > timestampValue(current) ? candidate : current;
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function timestampValue(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const next = Date.parse(value);
  return Number.isNaN(next) ? 0 : next;
}

export function getAgentSourceKind(agent: AgentDescriptor): AgentSourceKind {
  if (agent.id.startsWith("copilot-session-")) {
    return "copilot-session-state";
  }

  if (agent.id.startsWith("claude-session-")) {
    return "claude-project-logs";
  }

  if (agent.id.startsWith("gemini-session-")) {
    return "gemini-project-chats";
  }

  if (agent.id.startsWith("openclaw-agent-")) {
    return "openclaw-status-cli";
  }

  if (SEEDED_DEMO_AGENT_IDS.has(agent.id)) {
    return "seeded-demo";
  }

  if (agent.platform === "generic") {
    return "external-ingest";
  }

  return "live-adapter";
}

export function getRunActionSupport(
  agent: AgentDescriptor | null | undefined,
): RunActionSupport {
  if (!agent) {
    return {
      supported: false,
      code: "agent-missing",
    };
  }

  switch (getAgentSourceKind(agent)) {
    case "seeded-demo":
      return {
        supported: true,
        code: "mock-runtime",
      };
    case "copilot-session-state":
      return {
        supported: false,
        code: "copilot-discovery-readonly",
      };
    case "claude-project-logs":
      return {
        supported: false,
        code: "claude-discovery-readonly",
      };
    case "gemini-project-chats":
      return {
        supported: false,
        code: "gemini-discovery-readonly",
      };
    case "openclaw-status-cli":
      return {
        supported: false,
        code: "openclaw-discovery-readonly",
      };
    case "external-ingest":
      return {
        supported: false,
        code: "external-ingest-readonly",
      };
    default:
      return {
        supported: false,
        code: "live-adapter-readonly",
      };
  }
}

export function hasAgentWorkspaceActionSupport(
  agent: AgentDescriptor | null | undefined,
  action: AgentWorkspaceActionTarget,
): boolean {
  if (!agent) {
    return false;
  }

  switch (action) {
    case "finder":
    case "terminal":
      return true;
    case "session_state":
      return (
        SESSION_STATE_SOURCE_KINDS.has(getAgentSourceKind(agent)) &&
        typeof agent.sessionMetadata?.sessionPath === "string" &&
        agent.sessionMetadata.sessionPath.trim().length > 0
      );
    case "runtime_home":
      return (
        getAgentSourceKind(agent) !== "seeded-demo" &&
        getAgentSourceKind(agent) !== "external-ingest" &&
        RUNTIME_HOME_PLATFORMS.has(agent.platform)
      );
  }
}

export function listAvailableRunActions(run: AgentRun): RunAction[] {
  const actions: RunAction[] = [];

  if (
    RESUMABLE_WAITING_REASONS.has(run.waitingReason ?? "unknown") &&
    !TERMINAL_RUN_STATES.has(run.state)
  ) {
    actions.push("approve");
  }

  if (
    run.state === "ready" ||
    run.state === "queued" ||
    run.state === "starting" ||
    run.state === "running"
  ) {
    actions.push("pause");
  }

  if (run.state === "paused") {
    actions.push("resume");
  }

  if (!TERMINAL_RUN_STATES.has(run.state)) {
    actions.push("cancel");
  }

  return actions;
}

export function isLoopbackRuntimeActionEndpoint(
  value: string | null | undefined,
): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  try {
    const endpoint = new URL(value);
    return (
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      LOOPBACK_RUNTIME_HOSTS.has(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

export function hasDeclaredRuntimeActionTarget(
  metadata: AgentSessionMetadata | null | undefined,
  action: AgentRuntimeActionTarget,
): boolean {
  return (
    Array.isArray(metadata?.runtimeActionTargets) &&
    metadata.runtimeActionTargets.includes(action)
  );
}

export function getAgentRuntimeActionSupport(
  agent: AgentDescriptor | null | undefined,
  action: AgentRuntimeActionTarget,
): AgentRuntimeActionSupport {
  const explicitSupport = agent?.runtimeActionSupport?.[action];
  if (explicitSupport) {
    return explicitSupport;
  }

  if (!agent) {
    return {
      supported: false,
      code: "agent-missing",
    };
  }

  switch (action) {
    case "recover_gateway":
      if (getAgentSourceKind(agent) !== "openclaw-status-cli") {
        return {
          supported: false,
          code: "unsupported-runtime",
        };
      }

      if (agent.sessionMetadata?.gatewayReachable === true) {
        return {
          supported: false,
          code: "openclaw-gateway-healthy",
        };
      }

      return {
        supported: true,
        code: "openclaw-gateway-recovery",
      };
    case "reset_session":
      if (getAgentSourceKind(agent) !== "openclaw-status-cli") {
        return {
          supported: false,
          code: "unsupported-runtime",
        };
      }

      if (
        agent.sessionMetadata?.gatewayReachable !== true ||
        !agent.sessionMetadata?.sessionKey
      ) {
        return {
          supported: false,
          code: "openclaw-session-unavailable",
        };
      }

      return {
        supported: true,
        code: "openclaw-session-reset",
      };
    case "send_prompt":
      if (getAgentSourceKind(agent) === "openclaw-status-cli") {
        if (
          agent.sessionMetadata?.gatewayReachable !== true ||
          !agent.sessionMetadata?.sessionId
        ) {
          return {
            supported: false,
            code: "openclaw-prompt-unavailable",
          };
        }

        return {
          supported: true,
          code: "openclaw-prompt-dispatch",
        };
      }

      if (getAgentSourceKind(agent) === "copilot-session-state") {
        if (
          !agent.sessionMetadata?.sessionId ||
          !agent.sessionMetadata?.sessionPath
        ) {
          return {
            supported: false,
            code: "copilot-prompt-unavailable",
          };
        }

        return {
          supported: true,
          code: "copilot-prompt-dispatch",
        };
      }

      if (getAgentSourceKind(agent) === "claude-project-logs") {
        if (agent.health === "auth_required") {
          return {
            supported: false,
            code: "claude-auth-required",
          };
        }

        if (
          agent.health === "unavailable" ||
          !agent.sessionMetadata?.sessionId ||
          !agent.sessionMetadata?.sessionPath
        ) {
          return {
            supported: false,
            code: "claude-prompt-unavailable",
          };
        }

        return {
          supported: true,
          code: "claude-prompt-dispatch",
        };
      }

      if (getAgentSourceKind(agent) === "gemini-project-chats") {
        if (agent.health === "auth_required") {
          return {
            supported: false,
            code: "gemini-auth-required",
          };
        }

        if (
          agent.health === "unavailable" ||
          !agent.sessionMetadata?.sessionId ||
          !agent.sessionMetadata?.sessionPath
        ) {
          return {
            supported: false,
            code: "gemini-prompt-unavailable",
          };
        }

        return {
          supported: true,
          code: "gemini-prompt-dispatch",
        };
      }

      if (getAgentSourceKind(agent) === "external-ingest") {
        if (
          !isLoopbackRuntimeActionEndpoint(
            agent.sessionMetadata?.runtimeActionEndpoint ?? null,
          ) ||
          !hasDeclaredRuntimeActionTarget(agent.sessionMetadata, "send_prompt")
        ) {
          return {
            supported: false,
            code: "sidecar-prompt-unavailable",
          };
        }

        return {
          supported: true,
          code: "sidecar-prompt-dispatch",
        };
      }

      return {
        supported: false,
        code: "unsupported-runtime",
      };
  }
}

export function getSessionTerminalAttachSupport(
  agent: AgentDescriptor | null | undefined,
  session: SessionDescriptor | null | undefined,
): SessionTerminalAttachSupport {
  if (!agent || !session || session.agentId !== agent.id) {
    return {
      supported: false,
      code: "session-missing",
    };
  }

  const runtimeSessionId =
    session.sessionId?.trim() ?? agent.sessionMetadata?.sessionId?.trim() ?? "";
  if (!runtimeSessionId) {
    return {
      supported: false,
      code: "session-id-missing",
    };
  }

  switch (agent.platform) {
    case "claude-code":
      return {
        supported: true,
        code: "claude-resume-terminal",
      };
    case "gemini-cli":
      return {
        supported: true,
        code: "gemini-resume-terminal",
      };
    default:
      return {
        supported: false,
        code: "session-attach-unsupported-runtime",
      };
  }
}

export function listAvailableAgentRuntimeActions(
  agent: AgentDescriptor | null | undefined,
): AgentRuntimeActionTarget[] {
  const actions: AgentRuntimeActionTarget[] = [];

  if (getAgentRuntimeActionSupport(agent, "recover_gateway").supported) {
    actions.push("recover_gateway");
  }

  if (getAgentRuntimeActionSupport(agent, "reset_session").supported) {
    actions.push("reset_session");
  }

  if (getAgentRuntimeActionSupport(agent, "send_prompt").supported) {
    actions.push("send_prompt");
  }

  return actions;
}

export function hasAgentRuntimeControlSurface(
  agent: AgentDescriptor | null | undefined,
): boolean {
  if (!agent) {
    return false;
  }

  const supportEntries = Object.values(agent.runtimeActionSupport ?? {});
  if (
    supportEntries.some(
      (entry) =>
        entry !== undefined &&
        entry.code !== "unsupported-runtime" &&
        entry.code !== "agent-missing",
    )
  ) {
    return true;
  }

  return listAvailableAgentRuntimeActions(agent).length > 0;
}

export function getApprovalResolveSupport(
  approval: ApprovalItem | null | undefined,
  bridge: ApprovalBridgeStatus | null | undefined,
): ApprovalResolveSupport {
  if (!approval || approval.state !== "pending") {
    return {
      supported: false,
      code: "approval-not-pending",
    };
  }

  if (approval.platform === "openclaw" && bridge?.connected === true) {
    return {
      supported: true,
      code: "openclaw-bridge-live",
    };
  }

  return {
    supported: false,
    code: "openclaw-bridge-disconnected",
  };
}
