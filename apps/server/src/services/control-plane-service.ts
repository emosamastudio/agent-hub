import { randomUUID } from "node:crypto";

import { SEEDED_DEMO_AGENT_IDS } from "../db/seed.js";
import type { SqliteDatabase } from "../db/index.js";
import { AgentRepository } from "../repositories/agent-repository.js";
import { ApprovalRepository } from "../repositories/approval-repository.js";
import { EventRepository } from "../repositories/event-repository.js";
import {
  InboxRepository,
  type InboxEntry,
} from "../repositories/inbox-repository.js";
import { ResourcePolicyRepository } from "../repositories/resource-policy-repository.js";
import { RunRepository } from "../repositories/run-repository.js";
import { TaskAssignmentRepository } from "../repositories/task-assignment-repository.js";
import { TaskHandoffRepository } from "../repositories/task-handoff-repository.js";
import { TaskPriorityRepository } from "../repositories/task-priority-repository.js";
import {
  deriveOperationalTopology,
  deriveProjectDescriptorId,
  deriveResourceDescriptors,
  deriveSessionDescriptorId,
  getAgentRuntimeActionSupport,
  getRunActionSupport,
} from "../shared-types.js";
import type {
  AgentRuntimeActionTarget,
  AgentAttention,
  AgentDescriptor,
  AgentIngestPayload,
  AgentIngestResult,
  AgentEvent,
  AgentEventType,
  AgentRun,
  ApprovalDecision,
  ApprovalBridgeStatus,
  ApprovalItem,
  ApprovalPlatform,
  DashboardSnapshot,
  AgentPlatform,
  ResourceDescriptor,
  ResourcePolicyState,
  ResourcePolicyUpdateResult,
  RunAction,
  RunActionSupportCode,
  RunProgress,
  RunState,
  SessionActionTarget,
  TaskAssignmentState,
  TaskPriority,
  TaskPriorityState,
  TaskHandoffState,
  WaitingReason,
} from "../shared-types.js";

const terminalStates = new Set<RunState>([
  "completed",
  "failed",
  "cancelled",
  "offline",
]);

const resumableWaitingReasons: readonly WaitingReason[] = [
  "approval",
  "human_review",
  "tool_permission",
  "missing_context",
  "unknown",
];

export class ControlPlaneError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export interface ActionResult {
  run: AgentRun;
  event: AgentEvent;
  snapshot: DashboardSnapshot;
}

export interface EventResult {
  event: AgentEvent;
  snapshot: DashboardSnapshot;
}

export interface RuntimeRemovalResult {
  event: AgentEvent | null;
  snapshot: DashboardSnapshot;
}

export interface TaskAssignmentMutationResult {
  taskId: string;
  runId: string;
  owner: string | null;
  message: string;
  event: AgentEvent | null;
  snapshot: DashboardSnapshot;
}

export interface TaskPriorityMutationResult {
  taskId: string;
  runId: string;
  priority: TaskPriority;
  message: string;
  event: AgentEvent | null;
  snapshot: DashboardSnapshot;
}

export interface TaskHandoffMutationResult {
  taskId: string;
  runId: string;
  owner: string | null;
  targetOwner: string | null;
  note: string | null;
  message: string;
  event: AgentEvent | null;
  snapshot: DashboardSnapshot;
}

interface ResourceSnapshotResult {
  snapshot: DashboardSnapshot;
  resource: ResourceDescriptor;
}

interface RunTransition {
  run: AgentRun;
  eventType: AgentEventType;
  message: string;
}

function isTerminalState(state: RunState): boolean {
  return terminalStates.has(state);
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function buildProgress(
  run: AgentRun,
  overrides: Partial<RunProgress>,
): RunProgress {
  const base: RunProgress = run.progress ?? {
    phase: "working",
    percent: null,
    message: `${run.title} is running locally.`,
  };

  return {
    phase: overrides.phase ?? base.phase,
    percent:
      overrides.percent === undefined ? base.percent : overrides.percent,
    message: overrides.message ?? base.message,
  };
}

function describeProgress(run: AgentRun, percent: number): string {
  const title = run.title.toLowerCase();

  if (title.includes("index")) {
    return `Indexed ${percent}% of the local chain replay buffer.`;
  }

  if (title.includes("review")) {
    return `Validated ${percent}% of the review checklist for ${run.title}.`;
  }

  if (title.includes("release")) {
    return `Validated ${percent}% of the release hotfix workflow.`;
  }

  return `Completed ${percent}% of ${run.title}.`;
}

function describePhase(percent: number): string {
  if (percent < 30) {
    return "planning";
  }

  if (percent < 70) {
    return "executing";
  }

  if (percent < 95) {
    return "verifying";
  }

  return "wrapping up";
}

function describeUnsupportedRunAction(
  run: AgentRun,
  action: RunAction,
  code: RunActionSupportCode,
): string {
  switch (code) {
    case "copilot-discovery-readonly":
      return `Run ${run.id} was discovered from local Copilot session-state metadata. Agent Hub can observe it truthfully, but cannot ${action} it until a real Copilot control bridge exists.`;
    case "claude-discovery-readonly":
      return `Run ${run.id} was discovered from local Claude project logs and active Claude CLI processes. Agent Hub can observe it truthfully, but cannot ${action} it until a real Claude Code control bridge exists.`;
    case "openclaw-discovery-readonly":
      return `Run ${run.id} was discovered from local OpenClaw status metadata and live runtime signals. Agent Hub can observe it truthfully, but cannot ${action} it until a real OpenClaw control bridge exists.`;
    case "external-ingest-readonly":
      return `Run ${run.id} was published through external ingest. Agent Hub may still expose separate runtime actions such as prompt dispatch when that sidecar declares them, but ${action} stays read-only until the adapter also exposes a truthful run-action bridge.`;
    case "live-adapter-readonly":
      return `Run ${run.id} is visible in Agent Hub, but no truthful ${action} bridge has been wired for this runtime yet.`;
    case "agent-missing":
      return `Run ${run.id} cannot be controlled because its agent metadata is missing.`;
    default:
      return `Run ${run.id} does not support truthful ${action} actions from Agent Hub.`;
  }
}

function transitionRunForAction(
  run: AgentRun,
  action: RunAction,
  timestamp: string,
): RunTransition {
  switch (action) {
    case "approve": {
      if (
        run.state !== "waiting_input" ||
        !run.waitingReason ||
        !resumableWaitingReasons.includes(run.waitingReason)
      ) {
        throw new ControlPlaneError(
          409,
          `Run ${run.id} is not awaiting approval.`,
        );
      }

      return {
        run: {
          ...run,
          state: "running",
          health: "healthy",
          attention: "info",
          waitingReason: null,
          progress: buildProgress(run, {
            phase: "executing",
            message: "Approval received. Continuing the local execution plan.",
          }),
          lastEventAt: timestamp,
        },
        eventType: "run.resumed",
        message: `${run.title} was approved from the control plane.`,
      };
    }
    case "pause": {
      if (!["queued", "starting", "running"].includes(run.state)) {
        throw new ControlPlaneError(
          409,
          `Run ${run.id} cannot be paused from state ${run.state}.`,
        );
      }

      return {
        run: {
          ...run,
          state: "paused",
          attention: "action_needed",
          waitingReason: "human_review",
          progress: buildProgress(run, {
            message: "Paused from the control plane for human review.",
          }),
          lastEventAt: timestamp,
        },
        eventType: "run.paused",
        message: `${run.title} was paused from the control plane.`,
      };
    }
    case "resume": {
      if (run.state !== "paused") {
        throw new ControlPlaneError(
          409,
          `Run ${run.id} is not paused.`,
        );
      }

      return {
        run: {
          ...run,
          state: "running",
          health: "healthy",
          attention: "info",
          waitingReason: null,
          progress: buildProgress(run, {
            phase: run.progress?.phase ?? "executing",
            message: "Resumed from the control plane.",
          }),
          lastEventAt: timestamp,
        },
        eventType: "run.resumed",
        message: `${run.title} resumed from the control plane.`,
      };
    }
    case "cancel": {
      if (isTerminalState(run.state)) {
        throw new ControlPlaneError(
          409,
          `Run ${run.id} is already terminal.`,
        );
      }

      return {
        run: {
          ...run,
          state: "cancelled",
          attention: "info",
          waitingReason: null,
          progress: buildProgress(run, {
            message: "Cancelled from the control plane.",
          }),
          lastEventAt: timestamp,
        },
        eventType: "run.cancelled",
        message: `${run.title} was cancelled from the control plane.`,
      };
    }
  }
}

export class ControlPlaneService {
  private readonly approvalBridgeStatus = new Map<
    ApprovalPlatform,
    ApprovalBridgeStatus
  >();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly agents: AgentRepository,
    private readonly runs: RunRepository,
    private readonly inbox: InboxRepository,
    private readonly approvals: ApprovalRepository,
    private readonly events: EventRepository,
    private readonly resourcePolicies: ResourcePolicyRepository,
    private readonly taskAssignments: TaskAssignmentRepository,
    private readonly taskPriorities: TaskPriorityRepository,
    private readonly taskHandoffs: TaskHandoffRepository,
  ) {}

  listAgents(): AgentDescriptor[] {
    return this.agents.list().map((agent) => this.withAgentCapabilities(agent));
  }

  getAgent(agentId: string): AgentDescriptor | null {
    const agent = this.agents.getById(agentId);
    return agent ? this.withAgentCapabilities(agent) : null;
  }

  listRuns(): AgentRun[] {
    return this.runs.list();
  }

  listInbox(): AgentRun[] {
    return this.inbox.listRuns();
  }

  listApprovals(): ApprovalItem[] {
    return this.approvals.listPending();
  }

  getApproval(approvalId: string): ApprovalItem | null {
    return this.approvals.getById(approvalId);
  }

  getApprovalBridgeStatus(
    platform: ApprovalPlatform,
  ): ApprovalBridgeStatus | null {
    return this.approvalBridgeStatus.get(platform) ?? null;
  }

  setApprovalBridgeStatus(status: ApprovalBridgeStatus): void {
    this.approvalBridgeStatus.set(status.platform, status);
  }

  listEvents(limit = 50): AgentEvent[] {
    return this.events.list(limit);
  }

  listProjects() {
    return this.getOperationalTopology().projects;
  }

  listSessions() {
    return this.getOperationalTopology().sessions;
  }

  getSession(sessionId: string) {
    return this.listSessions().find((session) => session.id === sessionId) ?? null;
  }

  listTasks() {
    return this.getOperationalTopology().tasks;
  }

  listResources() {
    const topology = this.getOperationalTopology();
    return deriveResourceDescriptors({
      sessions: topology.sessions,
      tasks: topology.tasks,
      resourcePolicies: this.resourcePolicies.list(),
    });
  }

  getTask(taskId: string) {
    return this.getOperationalTopology().tasks.find((task) => task.id === taskId) ?? null;
  }

  setResourcePolicy(
    platform: AgentPlatform,
    slotLimit: number | null,
  ): ResourcePolicyUpdateResult {
    return this.db.transaction(
      (targetPlatform: AgentPlatform, requestedSlotLimit: number | null) => {
        const existing = this.resourcePolicies.getByPlatform(targetPlatform);

        if (requestedSlotLimit === null) {
          if (existing) {
            this.resourcePolicies.deleteByPlatform(targetPlatform);
          }

          const { snapshot, resource } = this.buildResourceSnapshot(targetPlatform);
          return {
            ok: true,
            resourceId: resource.id,
            platform: targetPlatform,
            slotLimit: null,
            message: existing
              ? `Cleared the ${targetPlatform} slot limit.`
              : `${targetPlatform} already has an unlimited slot policy.`,
            resource,
            snapshot,
          } satisfies ResourcePolicyUpdateResult;
        }

        if (existing?.slotLimit === requestedSlotLimit) {
          const { snapshot, resource } = this.buildResourceSnapshot(targetPlatform);
          return {
            ok: true,
            resourceId: resource.id,
            platform: targetPlatform,
            slotLimit: requestedSlotLimit,
            message: `${targetPlatform} is already capped at ${requestedSlotLimit} slot${
              requestedSlotLimit === 1 ? "" : "s"
            }.`,
            resource,
            snapshot,
          } satisfies ResourcePolicyUpdateResult;
        }

        this.resourcePolicies.upsert({
          platform: targetPlatform,
          slotLimit: requestedSlotLimit,
          updatedAt: new Date().toISOString(),
        } satisfies ResourcePolicyState);

        const { snapshot, resource } = this.buildResourceSnapshot(targetPlatform);
        return {
          ok: true,
          resourceId: resource.id,
          platform: targetPlatform,
          slotLimit: requestedSlotLimit,
          message: `Set the ${targetPlatform} slot limit to ${requestedSlotLimit}.`,
          resource,
          snapshot,
        } satisfies ResourcePolicyUpdateResult;
      },
    )(platform, slotLimit);
  }

  setTaskPriority(
    taskId: string,
    priority: TaskPriority,
  ): TaskPriorityMutationResult {
    return this.db.transaction(
      (
        targetTaskId: string,
        requestedPriority: TaskPriority,
      ): TaskPriorityMutationResult => {
        const task = this.getTask(targetTaskId);

        if (!task) {
          throw new ControlPlaneError(404, `Task ${targetTaskId} was not found.`);
        }

        const run = this.runs.getById(task.runId);
        if (!run) {
          throw new ControlPlaneError(
            404,
            `Run ${task.runId} for task ${targetTaskId} was not found.`,
          );
        }

        const normalizedPriority = normalizeTaskPriority(requestedPriority);
        const existingPriority = this.taskPriorities.getByRunId(task.runId)?.priority
          ?? task.priority
          ?? "normal";

        if (normalizedPriority === existingPriority) {
          return {
            taskId: task.id,
            runId: task.runId,
            priority: normalizedPriority,
            message: `Task ${task.title} is already prioritized as ${normalizedPriority}.`,
            event: null,
            snapshot: this.getSnapshot(),
          };
        }

        const timestamp = new Date().toISOString();
        if (normalizedPriority === "normal") {
          this.taskPriorities.deleteByRunId(task.runId);
        } else {
          this.taskPriorities.upsert({
            runId: task.runId,
            priority: normalizedPriority,
            updatedAt: timestamp,
          } satisfies TaskPriorityState);
        }

        const message =
          normalizedPriority === "normal"
            ? `Task ${task.title} priority was reset from ${existingPriority} to normal.`
            : `Task ${task.title} priority changed from ${existingPriority} to ${normalizedPriority}.`;
        const event = this.buildTaskPriorityEvent(
          run,
          "task.priority_changed",
          normalizedPriority,
          message,
          timestamp,
        );
        this.events.insert(event);

        return {
          taskId: task.id,
          runId: task.runId,
          priority: normalizedPriority,
          message,
          event,
          snapshot: this.getSnapshot(),
        };
      },
    )(taskId, priority);
  }

  setTaskOwner(
    taskId: string,
    owner: string | null,
  ): TaskAssignmentMutationResult {
    return this.db.transaction(
      (
        targetTaskId: string,
        requestedOwner: string | null,
      ): TaskAssignmentMutationResult => {
        const task = this.getTask(targetTaskId);

        if (!task) {
          throw new ControlPlaneError(404, `Task ${targetTaskId} was not found.`);
        }

        const run = this.runs.getById(task.runId);
        if (!run) {
          throw new ControlPlaneError(
            404,
            `Run ${task.runId} for task ${targetTaskId} was not found.`,
          );
        }

        const normalizedOwner = normalizeTaskOwner(requestedOwner);
        const existingAssignment = this.taskAssignments.getByRunId(task.runId);
        const existingOwner = existingAssignment?.owner ?? null;
        const existingHandoff = this.taskHandoffs.getByRunId(task.runId);
        const clearedHandoffTarget = existingHandoff?.targetOwner ?? null;

        if (normalizedOwner === existingOwner) {
          return {
            taskId: task.id,
            runId: task.runId,
            owner: existingOwner,
            message:
              existingOwner === null
                ? `Task ${task.title} is already unassigned.`
                : `Task ${task.title} is already assigned to ${existingOwner}.`,
            event: null,
            snapshot: this.getSnapshot(),
          };
        }

        const timestamp = new Date().toISOString();
        let event: AgentEvent | null = null;
        let message = "";

        if (normalizedOwner) {
          const nextAssignment: TaskAssignmentState = {
            runId: task.runId,
            owner: normalizedOwner,
            assignedAt: existingAssignment?.assignedAt ?? timestamp,
            updatedAt: timestamp,
          };
          this.taskAssignments.upsert(nextAssignment);
          if (clearedHandoffTarget) {
            this.taskHandoffs.deleteByRunId(task.runId);
          }
          message =
            existingOwner === null
              ? `Task ${task.title} was assigned to ${normalizedOwner}.`
              : `Task ${task.title} was reassigned from ${existingOwner} to ${normalizedOwner}.`;
          event = this.buildTaskAssignmentEvent(
            run,
            "task.assigned",
            message,
            timestamp,
          );
        } else {
          this.taskAssignments.deleteByRunId(task.runId);
          if (clearedHandoffTarget) {
            this.taskHandoffs.deleteByRunId(task.runId);
          }
          message =
            existingOwner === null
              ? `Task ${task.title} is already unassigned.`
              : `Task ${task.title} was unassigned from ${existingOwner}.`;
          event = this.buildTaskAssignmentEvent(
            run,
            "task.unassigned",
            message,
            timestamp,
          );
        }

        if (event) {
          this.events.insert(event);
        }

        if (clearedHandoffTarget) {
          message = `${message} Pending handoff to ${clearedHandoffTarget} was cleared.`;
        }

        return {
          taskId: task.id,
          runId: task.runId,
          owner: normalizedOwner,
          message,
          event,
          snapshot: this.getSnapshot(),
        };
      },
    )(taskId, owner);
  }

  setTaskHandoff(
    taskId: string,
    targetOwner: string | null,
    note: string | null | undefined,
  ): TaskHandoffMutationResult {
    return this.db.transaction(
      (
        targetTaskId: string,
        requestedTargetOwner: string | null,
        requestedNote: string | null | undefined,
      ): TaskHandoffMutationResult => {
        const task = this.getTask(targetTaskId);

        if (!task) {
          throw new ControlPlaneError(404, `Task ${targetTaskId} was not found.`);
        }

        const run = this.runs.getById(task.runId);
        if (!run) {
          throw new ControlPlaneError(
            404,
            `Run ${task.runId} for task ${targetTaskId} was not found.`,
          );
        }

        const normalizedTargetOwner = normalizeTaskOwner(requestedTargetOwner);
        const normalizedNote = normalizeTaskNote(requestedNote);
        const existingHandoff = this.taskHandoffs.getByRunId(task.runId);
        const existingTargetOwner = existingHandoff?.targetOwner ?? null;
        const existingNote = existingHandoff?.note ?? null;

        if (normalizedTargetOwner) {
          if (!task.owner) {
            throw new ControlPlaneError(
              409,
              `Task ${task.title} must have an owner before a handoff can be requested.`,
            );
          }

          if (normalizedTargetOwner === task.owner) {
            throw new ControlPlaneError(
              409,
              `Task ${task.title} is already owned by ${task.owner}; handoff target must differ from the current owner.`,
            );
          }
        }

        if (
          normalizedTargetOwner === existingTargetOwner &&
          normalizedNote === existingNote
        ) {
          return {
            taskId: task.id,
            runId: task.runId,
            owner: task.owner,
            targetOwner: existingTargetOwner,
            note: existingNote,
            message:
              existingTargetOwner === null
                ? `Task ${task.title} does not have a pending handoff.`
                : `Task ${task.title} is already pending handoff to ${existingTargetOwner}.`,
            event: null,
            snapshot: this.getSnapshot(),
          };
        }

        const timestamp = new Date().toISOString();
        let event: AgentEvent | null = null;
        let message = "";

        if (normalizedTargetOwner) {
          const nextHandoff: TaskHandoffState = {
            runId: task.runId,
            targetOwner: normalizedTargetOwner,
            note: normalizedNote,
            requestedAt: existingHandoff?.requestedAt ?? timestamp,
            updatedAt: timestamp,
          };
          this.taskHandoffs.upsert(nextHandoff);
          message =
            existingTargetOwner === null
              ? `Task ${task.title} is pending handoff from ${task.owner} to ${normalizedTargetOwner}.`
              : `Task ${task.title} updated its pending handoff from ${existingTargetOwner} to ${normalizedTargetOwner}.`;
          event = this.buildTaskHandoffEvent(
            run,
            "task.handoff_requested",
            message,
            timestamp,
          );
        } else {
          this.taskHandoffs.deleteByRunId(task.runId);
          message =
            existingTargetOwner === null
              ? `Task ${task.title} does not have a pending handoff.`
              : `Task ${task.title} cleared its pending handoff to ${existingTargetOwner}.`;
          event = this.buildTaskHandoffEvent(
            run,
            "task.handoff_cleared",
            message,
            timestamp,
          );
        }

        if (event) {
          this.events.insert(event);
        }

        return {
          taskId: task.id,
          runId: task.runId,
          owner: task.owner,
          targetOwner: normalizedTargetOwner,
          note: normalizedTargetOwner ? normalizedNote : null,
          message,
          event,
          snapshot: this.getSnapshot(),
        };
      },
    )(taskId, targetOwner, note);
  }

  completeTaskHandoff(taskId: string): TaskHandoffMutationResult {
    return this.db.transaction(
      (targetTaskId: string): TaskHandoffMutationResult => {
        const task = this.getTask(targetTaskId);

        if (!task) {
          throw new ControlPlaneError(404, `Task ${targetTaskId} was not found.`);
        }

        const run = this.runs.getById(task.runId);
        if (!run) {
          throw new ControlPlaneError(
            404,
            `Run ${task.runId} for task ${targetTaskId} was not found.`,
          );
        }

        const existingHandoff = this.taskHandoffs.getByRunId(task.runId);
        if (!existingHandoff) {
          throw new ControlPlaneError(
            409,
            `Task ${task.title} does not have a pending handoff to complete.`,
          );
        }

        const existingAssignment = this.taskAssignments.getByRunId(task.runId);
        const currentOwner = existingAssignment?.owner ?? task.owner ?? null;
        if (!currentOwner) {
          throw new ControlPlaneError(
            409,
            `Task ${task.title} must have an owner before a handoff can be completed.`,
          );
        }

        const timestamp = new Date().toISOString();
        const nextOwner = existingHandoff.targetOwner;
        const nextAssignment: TaskAssignmentState = {
          runId: task.runId,
          owner: nextOwner,
          assignedAt: existingAssignment?.assignedAt ?? timestamp,
          updatedAt: timestamp,
        };

        this.taskAssignments.upsert(nextAssignment);
        this.taskHandoffs.deleteByRunId(task.runId);

        const message = existingHandoff.note
          ? `Task ${task.title} completed handoff from ${currentOwner} to ${nextOwner}. Note: ${existingHandoff.note}`
          : `Task ${task.title} completed handoff from ${currentOwner} to ${nextOwner}.`;
        const event = this.buildTaskHandoffEvent(
          run,
          "task.handoff_completed",
          message,
          timestamp,
        );
        this.events.insert(event);

        return {
          taskId: task.id,
          runId: task.runId,
          owner: nextOwner,
          targetOwner: null,
          note: null,
          message,
          event,
          snapshot: this.getSnapshot(),
        };
      },
    )(taskId);
  }

  getSnapshot(): DashboardSnapshot {
    const agents = this.listAgents();
    const runs = this.listRuns();
    const events = this.listEvents();
    const resourcePolicies = this.resourcePolicies.list();
    const taskAssignments = this.taskAssignments.list();
    const taskPriorities = this.taskPriorities.list();
    const taskHandoffs = this.taskHandoffs.list();
    const topology = deriveOperationalTopology({
      agents,
      runs,
      events,
      taskPriorities,
      taskAssignments,
      taskHandoffs,
    });
    const resources = deriveResourceDescriptors({
      sessions: topology.sessions,
      tasks: topology.tasks,
      resourcePolicies,
    });

    return {
      generatedAt: new Date().toISOString(),
      agents,
      runs,
      inbox: this.listInbox(),
      approvals: this.listApprovals(),
      approvalBridge: this.buildApprovalBridgeSnapshot(),
      events,
      projects: topology.projects,
      sessions: topology.sessions,
      tasks: topology.tasks,
      resources,
    };
  }

  private getOperationalTopology() {
    return deriveOperationalTopology({
      agents: this.listAgents(),
      runs: this.listRuns(),
      events: this.listEvents(),
      taskPriorities: this.taskPriorities.list(),
      taskAssignments: this.taskAssignments.list(),
      taskHandoffs: this.taskHandoffs.list(),
    });
  }

  private buildResourceSnapshot(platform: AgentPlatform): ResourceSnapshotResult {
    const snapshot = this.getSnapshot();
    const resource = snapshot.resources.find(
      (candidate) => candidate.platform === platform,
    );

    if (!resource) {
      throw new ControlPlaneError(
        500,
        `Resource projection for ${platform} is unavailable.`,
      );
    }

    return {
      snapshot,
      resource,
    };
  }

  purgeSeededDemoData(): void {
    this.db.transaction(() => {
      this.agents.deleteByIds([...SEEDED_DEMO_AGENT_IDS]);
    })();
  }

  removeRuntimeSession(
    agentId: string,
    runId: string,
    message: string,
  ): RuntimeRemovalResult {
    return this.db.transaction(
      (targetAgentId: string, targetRunId: string, eventMessage: string) => {
        const existingAgent = this.agents.getById(targetAgentId);
        const existingRun = this.runs.getById(targetRunId);

        this.inbox.deleteByRunId(targetRunId);

        if (existingAgent) {
          this.agents.deleteByIds([targetAgentId]);
        } else if (existingRun) {
          this.runs.deleteByIds([targetRunId]);
        }

        const nextEvent =
          existingAgent || existingRun
            ? this.buildEventRecord({
                agent: existingAgent,
                agentId: targetAgentId,
                runId: existingRun ? targetRunId : null,
                type: "agent.offline",
                state: "offline",
                attention: "info",
                message: eventMessage,
                timestamp: new Date().toISOString(),
              })
            : null;

        return {
          event: nextEvent,
          snapshot: this.getSnapshot(),
        };
      },
    )(agentId, runId, message);
  }

  ingestUpdate(payload: AgentIngestPayload): AgentIngestResult {
    return this.db.transaction((input: AgentIngestPayload) => {
      const timestamp = new Date().toISOString();
      const existingAgent = this.agents.getById(input.agent.id);
      const existingRun = input.run ? this.runs.getById(input.run.id) : null;

      if (input.run?.agentId && input.run.agentId !== input.agent.id) {
        throw new ControlPlaneError(
          409,
          `Run ${input.run.id} must belong to agent ${input.agent.id}.`,
        );
      }

      const nextRun: AgentRun | null = input.run
        ? {
            id: input.run.id,
            agentId: input.agent.id,
            title: input.run.title,
            state: input.run.state,
            health: input.run.health,
            attention: input.run.attention,
            waitingReason: input.run.waitingReason ?? null,
            progress: input.run.progress ?? null,
            lastEventAt:
              input.run.lastEventAt ??
              input.event?.createdAt ??
              existingRun?.lastEventAt ??
              timestamp,
            createdAt: input.run.createdAt ?? existingRun?.createdAt ?? timestamp,
          }
        : null;

      const impliedCurrentRunId =
        input.agent.currentRunId !== undefined
          ? input.agent.currentRunId
          : nextRun
            ? isTerminalState(nextRun.state)
              ? null
              : nextRun.id
            : existingAgent?.currentRunId ?? null;

      const nextAgent: AgentDescriptor = {
        id: input.agent.id,
        name: input.agent.name,
        platform: input.agent.platform,
        workspacePath: input.agent.workspacePath,
        state: input.agent.state,
        health: input.agent.health,
        attention: input.agent.attention,
        lastHeartbeatAt:
          input.agent.lastHeartbeatAt ?? existingAgent?.lastHeartbeatAt ?? timestamp,
        lastEventAt:
          latestTimestamp(
            input.agent.lastEventAt,
            nextRun?.lastEventAt,
            input.event?.createdAt,
            input.agent.lastHeartbeatAt,
            existingAgent?.lastEventAt,
          ) ?? timestamp,
        currentRunId: impliedCurrentRunId,
        sessionMetadata:
          input.agent.sessionMetadata === undefined
            ? existingAgent?.sessionMetadata ?? null
            : input.agent.sessionMetadata,
      };

      if (existingAgent) {
        this.agents.update(nextAgent);
      } else {
        this.agents.insertMany([nextAgent]);
      }

      if (nextRun) {
        if (existingRun) {
          this.runs.update(nextRun);
        } else {
          this.runs.insertMany([nextRun]);
        }

        this.syncInbox(nextRun);
      }

      let nextEvent: AgentEvent | null = null;

      if (input.event) {
        const eventRunId = input.event.runId ?? nextRun?.id ?? null;

        if (eventRunId && nextRun && eventRunId !== nextRun.id) {
          throw new ControlPlaneError(
            409,
            `Event run ${eventRunId} does not match ingested run ${nextRun.id}.`,
          );
        }

        if (eventRunId && !nextRun && !this.runs.getById(eventRunId)) {
          throw new ControlPlaneError(
            404,
            `Run ${eventRunId} was not found for the ingested event.`,
          );
        }

        nextEvent = this.buildEventRecord({
          agent: nextAgent,
          agentId: nextAgent.id,
          runId: eventRunId,
          type: input.event.type,
          state: input.event.state ?? nextRun?.state ?? nextAgent.state,
          attention:
            input.event.attention ?? nextRun?.attention ?? nextAgent.attention,
          message: input.event.message,
          timestamp: input.event.createdAt ?? timestamp,
          sourceEventId: input.event.sourceEventId ?? null,
          correlationId: input.event.correlationId ?? null,
        });

        this.events.insert(nextEvent);
      }

      const agent = this.agents.getById(nextAgent.id);

      if (!agent) {
        throw new ControlPlaneError(
          500,
          `Agent ${nextAgent.id} was not found after ingest.`,
        );
      }

      return {
        ok: true as const,
        agent,
        run: nextRun ? this.runs.getById(nextRun.id) : null,
        event: nextEvent,
        snapshot: this.getSnapshot(),
      };
    })(payload);
  }

  applyRunAction(runId: string, action: RunAction): ActionResult {
    return this.db.transaction((targetRunId: string, nextAction: RunAction) => {
      const run = this.runs.getById(targetRunId);

      if (!run) {
        throw new ControlPlaneError(404, `Run ${targetRunId} was not found.`);
      }

      const agent = this.agents.getById(run.agentId);

      if (!agent) {
        throw new ControlPlaneError(
          500,
          `Agent ${run.agentId} was not found for run ${run.id}.`,
        );
      }

      const actionSupport = getRunActionSupport(agent);

      if (!actionSupport.supported) {
        throw new ControlPlaneError(
          409,
          describeUnsupportedRunAction(run, nextAction, actionSupport.code),
        );
      }

      const timestamp = new Date().toISOString();
      const transition = transitionRunForAction(run, nextAction, timestamp);

      this.runs.update(transition.run);
      this.syncInbox(transition.run);
      this.syncAgent(transition.run);

      const event = this.buildEvent(
        transition.run,
        transition.eventType,
        transition.message,
        timestamp,
      );
      this.events.insert(event);

      return {
        run: transition.run,
        event,
        snapshot: this.getSnapshot(),
      };
    })(runId, action);
  }

  reconcileApprovalResolution(
    runId: string | null,
    decision: ApprovalDecision,
    timestamp: string,
  ): ActionResult | null {
    if (!runId) {
      return null;
    }

    return this.db.transaction(
      (
        targetRunId: string,
        nextDecision: ApprovalDecision,
        observedAt: string,
      ): ActionResult | null => {
        const run = this.runs.getById(targetRunId);
        if (!run) {
          return null;
        }

        if (run.state !== "waiting_input" || run.waitingReason !== "approval") {
          return null;
        }

        const transition: RunTransition =
          nextDecision === "allow-once"
            ? {
                run: {
                  ...run,
                  state: "running",
                  health: "healthy",
                  attention: "info",
                  waitingReason: null,
                  progress: buildProgress(run, {
                    phase: run.progress?.phase ?? "executing",
                    message:
                      "Approval resolved through the live OpenClaw bridge. Waiting for the next runtime update.",
                  }),
                  lastEventAt: observedAt,
                },
                eventType: "run.resumed",
                message: `${run.title} resumed after a live OpenClaw approval was allowed.`,
              }
            : {
                run: {
                  ...run,
                  state: "paused",
                  attention: "action_needed",
                  waitingReason: "human_review",
                  progress: buildProgress(run, {
                    message:
                      "Approval denied through the live OpenClaw bridge. Waiting for operator follow-up or the next runtime update.",
                  }),
                  lastEventAt: observedAt,
                },
                eventType: "run.paused",
                message: `${run.title} remains blocked after a live OpenClaw approval was denied.`,
              };

        this.runs.update(transition.run);
        this.syncInbox(transition.run);
        this.syncAgent(transition.run);

        const event = this.buildEvent(
          transition.run,
          transition.eventType,
          transition.message,
          observedAt,
        );
        this.events.insert(event);

        return {
          run: transition.run,
          event,
          snapshot: this.getSnapshot(),
        };
      },
    )(runId, decision, timestamp);
  }

  recordRuntimeActionAcknowledgement(params: {
    agentId: string;
    message: string;
    runId: string | null;
    target: AgentRuntimeActionTarget;
    timestamp: string;
  }): AgentEvent | null {
    return this.db.transaction(
      (
        targetAgentId: string,
        nextMessage: string,
        targetRunId: string | null,
        target: AgentRuntimeActionTarget,
        observedAt: string,
      ): AgentEvent | null => {
        const agent = this.agents.getById(targetAgentId);
        if (!agent) {
          return null;
        }

        const runId = targetRunId ?? agent.currentRunId ?? null;
        const run = runId ? this.runs.getById(runId) : null;
        const event = this.buildEventRecord({
          agent,
          agentId: agent.id,
          runId: run?.id ?? runId,
          type: "runtime.action_acknowledged",
          state: run?.state ?? agent.state,
          attention: describeRuntimeActionAttention(target),
          message: describeRuntimeActionMessage(target, nextMessage),
          timestamp: observedAt,
        });
        this.events.insert(event);
        return event;
      },
    )(params.agentId, params.message, params.runId, params.target, params.timestamp);
  }

  recordSessionActionAcknowledgement(params: {
    agentId: string;
    message: string;
    runId: string | null;
    target: SessionActionTarget;
    timestamp: string;
    correlationId?: string | null;
  }): AgentEvent | null {
    return this.db.transaction(
      (
        targetAgentId: string,
        nextMessage: string,
        targetRunId: string | null,
        target: SessionActionTarget,
        observedAt: string,
        correlationId: string | null,
      ): AgentEvent | null => {
        const agent = this.agents.getById(targetAgentId);
        if (!agent) {
          return null;
        }

        const runId = targetRunId ?? agent.currentRunId ?? null;
        const run = runId ? this.runs.getById(runId) : null;
        const event = this.buildEventRecord({
          agent,
          agentId: agent.id,
          runId: run?.id ?? runId,
          type:
            target === "dispatch_text" ? "session.dispatch_text" : "terminal.attach",
          state: run?.state ?? agent.state,
          attention: "info",
          message: describeSessionActionMessage(target, nextMessage),
          timestamp: observedAt,
          correlationId,
        });
        this.events.insert(event);
        return event;
      },
    )(
      params.agentId,
      params.message,
      params.runId,
      params.target,
      params.timestamp,
      params.correlationId ?? null,
    );
  }

  recordHeartbeat(agentId: string): EventResult {
    return this.db.transaction((targetAgentId: string) => {
      const agent = this.agents.getById(targetAgentId);

      if (!agent) {
        throw new ControlPlaneError(
          404,
          `Agent ${targetAgentId} was not found.`,
        );
      }

      const timestamp = new Date().toISOString();
      this.agents.touchHeartbeat(agent.id, timestamp);

      const refreshed = this.agents.getById(agent.id);

      if (!refreshed) {
        throw new ControlPlaneError(
          500,
          `Agent ${agent.id} disappeared during heartbeat refresh.`,
        );
      }

      const event = this.buildEventRecord({
        agent: refreshed,
        agentId: refreshed.id,
        runId: refreshed.currentRunId,
        type: "agent.heartbeat",
        state: refreshed.state,
        attention: refreshed.attention,
        message: `${refreshed.name} heartbeat received by the local control plane.`,
        timestamp,
      });

      this.events.insert(event);

      return {
        event,
        snapshot: this.getSnapshot(),
      };
    })(agentId);
  }

  advanceRunningRun(runId: string): ActionResult {
    return this.db.transaction((targetRunId: string) => {
      const run = this.runs.getById(targetRunId);

      if (!run) {
        throw new ControlPlaneError(404, `Run ${targetRunId} was not found.`);
      }

      if (run.state !== "running") {
        throw new ControlPlaneError(
          409,
          `Run ${targetRunId} is not currently running.`,
        );
      }

      const timestamp = new Date().toISOString();
      const currentPercent = run.progress?.percent ?? 0;
      const step = currentPercent >= 80 ? 20 : 11;
      const nextPercent = Math.min(currentPercent + step, 100);

      const nextRun: AgentRun =
        nextPercent >= 100
          ? {
              ...run,
              state: "completed",
              health: "healthy",
              attention: "silent",
              waitingReason: null,
              progress: {
                phase: "done",
                percent: 100,
                message: `${run.title} completed successfully on the local mock runtime.`,
              },
              lastEventAt: timestamp,
            }
          : {
              ...run,
              state: "running",
              health: "healthy",
              attention: "info",
              waitingReason: null,
              progress: {
                phase: describePhase(nextPercent),
                percent: nextPercent,
                message: describeProgress(run, nextPercent),
              },
              lastEventAt: timestamp,
            };

      this.runs.update(nextRun);
      this.syncInbox(nextRun);
      this.syncAgent(nextRun);

      const eventType: AgentEventType =
        nextPercent >= 100 ? "run.completed" : "run.progress";
      const message =
        nextPercent >= 100
          ? `${run.title} completed on the local mock runtime.`
          : describeProgress(run, nextPercent);

      const event = this.buildEvent(nextRun, eventType, message, timestamp);
      this.events.insert(event);

      return {
        run: nextRun,
        event,
        snapshot: this.getSnapshot(),
      };
    })(runId);
  }

  getNextRunningRun(): AgentRun | null {
    return this.runs.findNextRunning();
  }

  private syncInbox(run: AgentRun): void {
    if (run.state === "waiting_input" || run.state === "paused") {
      const reason = run.waitingReason ?? "human_review";
      const entry: InboxEntry = {
        id: `inbox-${run.id}`,
        runId: run.id,
        agentId: run.agentId,
        reason,
        createdAt: run.lastEventAt,
        updatedAt: run.lastEventAt,
      };

      this.inbox.upsert(entry);
      return;
    }

    this.inbox.deleteByRunId(run.id);
  }

  private syncAgent(run: AgentRun): void {
    const agent = this.agents.getById(run.agentId);

    if (!agent) {
      throw new ControlPlaneError(
        500,
        `Agent ${run.agentId} was not found for run ${run.id}.`,
      );
    }

    const nextAgent: AgentDescriptor = isTerminalState(run.state)
      ? {
          ...agent,
          state: agent.currentRunId === run.id ? "ready" : agent.state,
          health: agent.currentRunId === run.id ? "healthy" : agent.health,
          attention:
            agent.currentRunId === run.id ? "silent" : agent.attention,
          lastEventAt: run.lastEventAt,
          currentRunId:
            agent.currentRunId === run.id ? null : agent.currentRunId,
        }
      : {
          ...agent,
          state: run.state,
          health: run.health,
          attention: run.attention,
          lastEventAt: run.lastEventAt,
          currentRunId: run.id,
        };

    this.agents.update(nextAgent);
  }

  private buildEvent(
    run: AgentRun,
    type: AgentEventType,
    message: string,
    timestamp: string,
  ): AgentEvent {
    return this.buildEventRecord({
      agentId: run.agentId,
      runId: run.id,
      type,
      state: run.state,
      attention: run.attention,
      message,
      timestamp,
    });
  }

  private buildTaskAssignmentEvent(
    run: AgentRun,
    type: Extract<AgentEventType, "task.assigned" | "task.unassigned">,
    message: string,
    timestamp: string,
  ): AgentEvent {
    return this.buildEventRecord({
      agentId: run.agentId,
      runId: run.id,
      type,
      state: run.state,
      attention: "info",
      message,
      timestamp,
    });
  }

  private buildTaskPriorityEvent(
    run: AgentRun,
    type: Extract<AgentEventType, "task.priority_changed">,
    priority: TaskPriority,
    message: string,
    timestamp: string,
  ): AgentEvent {
    return this.buildEventRecord({
      agentId: run.agentId,
      runId: run.id,
      type,
      state: run.state,
      attention: describeTaskPriorityAttention(priority),
      message,
      timestamp,
    });
  }

  private buildTaskHandoffEvent(
    run: AgentRun,
    type: Extract<
      AgentEventType,
      "task.handoff_requested" | "task.handoff_cleared" | "task.handoff_completed"
    >,
    message: string,
    timestamp: string,
  ): AgentEvent {
    return this.buildEventRecord({
      agentId: run.agentId,
      runId: run.id,
      type,
      state: run.state,
      attention: type === "task.handoff_requested" ? "action_needed" : "info",
      message,
      timestamp,
    });
  }

  private buildEventRecord(params: {
    agent?: AgentDescriptor | null;
    agentId: string;
    runId: string | null;
    type: AgentEventType;
    state: RunState | null;
    attention: AgentAttention;
    message: string;
    timestamp: string;
    sourceEventId?: string | null;
    correlationId?: string | null;
  }): AgentEvent {
    const agent = params.agent ?? this.agents.getById(params.agentId);
    return {
      id: randomUUID(),
      runId: params.runId,
      agentId: params.agentId,
      sessionKey: deriveSessionDescriptorId(params.agentId),
      projectId: deriveProjectDescriptorId(
        agent?.workspacePath ?? "",
        params.agentId,
      ),
      sourceEventId: params.sourceEventId ?? null,
      correlationId: params.correlationId ?? null,
      type: params.type,
      state: params.state,
      attention: params.attention,
      message: params.message,
      createdAt: params.timestamp,
    };
  }

  private withAgentCapabilities(agent: AgentDescriptor): AgentDescriptor {
    return {
      ...agent,
      runtimeActionSupport: {
        recover_gateway: getAgentRuntimeActionSupport(agent, "recover_gateway"),
        reset_session: getAgentRuntimeActionSupport(agent, "reset_session"),
        send_prompt: getAgentRuntimeActionSupport(agent, "send_prompt"),
      },
    };
  }

  private buildApprovalBridgeSnapshot():
    | Partial<Record<ApprovalPlatform, ApprovalBridgeStatus>>
    | null {
    if (this.approvalBridgeStatus.size === 0) {
      return null;
    }

    return Object.fromEntries(this.approvalBridgeStatus.entries());
  }
}

function describeRuntimeActionAttention(
  target: AgentRuntimeActionTarget,
): AgentAttention {
  switch (target) {
    case "recover_gateway":
    case "reset_session":
    case "send_prompt":
      return "info";
  }
}

function describeRuntimeActionMessage(
  target: AgentRuntimeActionTarget,
  message: string,
): string {
  switch (target) {
    case "send_prompt":
      return `${message} Agent Hub is waiting for the next upstream runtime event before changing run state.`;
    case "recover_gateway":
    case "reset_session":
      return message;
  }
}

function describeSessionActionMessage(
  target: SessionActionTarget,
  message: string,
): string {
  switch (target) {
    case "dispatch_text":
      return `${message} Agent Hub routed that prompt through the selected session identity instead of an anonymous terminal target.`;
    case "attach_terminal":
      return message;
  }
}

function normalizeTaskOwner(owner: string | null): string | null {
  const trimmed = owner?.trim();
  return trimmed ? trimmed : null;
}

function normalizeTaskPriority(priority: TaskPriority): TaskPriority {
  switch (priority) {
    case "low":
    case "normal":
    case "high":
    case "critical":
      return priority;
  }
}

function normalizeTaskNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

function describeTaskPriorityAttention(priority: TaskPriority): AgentAttention {
  switch (priority) {
    case "critical":
      return "urgent";
    case "high":
      return "action_needed";
    default:
      return "info";
  }
}
