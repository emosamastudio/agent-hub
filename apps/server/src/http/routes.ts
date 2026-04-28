import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  AgentIngestPayload,
  ApprovalDecision,
  AgentRuntimeActionRequest,
  AgentPlatform,
  SessionActionRequest,
  ResourcePolicyUpdateRequest,
  TaskPriorityRequest,
  TaskAssignmentRequest,
  TaskHandoffActionRequest,
  TaskHandoffRequest,
  AgentWorkspaceActionRequest,
  RunAction,
} from "../shared-types.js";
import {
  hasDeclaredRuntimeActionTarget,
  isLoopbackRuntimeActionEndpoint,
} from "../shared-types.js";
import type { ApprovalOperatorService } from "../services/approval-operator.js";
import {
  ControlPlaneError,
  type ControlPlaneService,
} from "../services/control-plane-service.js";
import type {
  HubNotifier,
  HubStreamMessage,
} from "../services/notifier.js";
import type { OpenClawRuntimeService } from "../services/openclaw-runtime.js";
import { referenceCatalog } from "../services/reference-catalog.js";
import type { RuntimeOperatorService } from "../services/runtime-operator.js";
import type { TerminalLifecycleService } from "../services/terminal-lifecycle.js";
import type { WorkspaceOperatorService } from "../services/workspace-operator.js";

const attentionSchema = z.enum(["silent", "info", "action_needed", "urgent"]);
const healthSchema = z.enum([
  "healthy",
  "degraded",
  "stalled",
  "rate_limited",
  "auth_required",
  "unavailable",
]);
const platformSchema = z.enum([
  "claude-code",
  "copilot-cli",
  "gemini-cli",
  "openclaw",
  "generic",
]);
const runStateSchema = z.enum([
  "discovered",
  "ready",
  "queued",
  "starting",
  "running",
  "waiting_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "offline",
]);
const waitingReasonSchema = z.enum([
  "approval",
  "missing_context",
  "tool_permission",
  "login_required",
  "human_review",
  "unknown",
]);
const eventTypeSchema = z.enum([
  "agent.registered",
  "agent.heartbeat",
  "session.opened",
  "session.dispatch_text",
  "task.priority_changed",
  "task.assigned",
  "task.handoff_requested",
  "task.handoff_completed",
  "task.handoff_cleared",
  "task.unassigned",
  "terminal.attach",
  "runtime.action_acknowledged",
  "run.queued",
  "run.started",
  "run.progress",
  "run.output",
  "run.waiting_input",
  "run.approval_required",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.stalled",
  "run.resumed",
  "approval.requested",
  "approval.resolved",
  "approval.expired",
  "approval.bridge_disconnected",
  "agent.offline",
  "agent.recovered",
]);

const runActionSchema = z.object({
  action: z.enum(["approve", "pause", "resume", "cancel"]),
});
const runtimeActionTargetSchema = z.enum([
  "recover_gateway",
  "reset_session",
  "send_prompt",
]);
const runtimeActionSchema = z
  .object({
    target: runtimeActionTargetSchema,
    message: z.string().trim().min(1).max(4_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.target === "send_prompt" && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "A prompt message is required when target=send_prompt.",
      });
    }
  });
const sessionActionSchema = z
  .object({
    target: z.enum(["dispatch_text", "attach_terminal"]),
    message: z.string().trim().min(1).max(4_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.target === "dispatch_text" && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: "A prompt message is required when target=dispatch_text.",
      });
    }
  });
const taskAssignmentSchema = z.object({
  owner: z.string().trim().min(1).max(80).nullable(),
});
const taskPrioritySchema = z.object({
  priority: z.enum(["low", "normal", "high", "critical"]),
});
const taskHandoffSchema = z.object({
  targetOwner: z.string().trim().min(1).max(80).nullable(),
  note: z.string().trim().max(240).nullable().optional(),
});
const taskHandoffActionSchema = z.object({
  action: z.enum(["complete"]),
});
const resourcePolicyUpdateSchema = z.object({
  slotLimit: z.number().int().min(0).max(99).nullable(),
});
const approvalResolveSchema = z.object({
  decision: z.enum(["allow-once", "deny"]),
});
const workspaceActionSchema = z.object({
  target: z.enum(["finder", "terminal", "session_state", "runtime_home"]),
});
const runProgressSchema = z.object({
  phase: z.string().min(1),
  percent: z.number().nullable(),
  message: z.string().min(1),
});
const upstreamApprovalSupportSchema = z.object({
  supported: z.boolean(),
  code: z.enum([
    "openclaw-acp-session",
    "openclaw-session-not-acp",
    "openclaw-session-unavailable",
  ]),
});
const sessionMetadataSchema = z
  .object({
    sessionId: z.string().min(1).nullable().optional(),
    sessionKey: z.string().min(1).nullable().optional(),
    sessionPath: z.string().min(1).nullable().optional(),
    gitRoot: z.string().min(1).nullable().optional(),
    branch: z.string().min(1).nullable().optional(),
    summary: z.string().min(1).nullable().optional(),
    summaryCount: z.number().finite().nullable().optional(),
    startedAt: z.string().min(1).nullable().optional(),
    updatedAt: z.string().min(1).nullable().optional(),
    toolVersion: z.string().min(1).nullable().optional(),
    remoteSteerable: z.boolean().nullable().optional(),
    alreadyInUse: z.boolean().nullable().optional(),
    gatewayUrl: z.string().min(1).nullable().optional(),
    gatewayReachable: z.boolean().nullable().optional(),
    gatewayError: z.string().min(1).nullable().optional(),
    gatewayServiceInstalled: z.boolean().nullable().optional(),
    gatewayServiceLoaded: z.boolean().nullable().optional(),
    gatewayServiceLoadedText: z.string().min(1).nullable().optional(),
    runtimeActionEndpoint: z.string().url().nullable().optional(),
    runtimeActionTargets: z.array(runtimeActionTargetSchema).min(1).nullable().optional(),
    upstreamApprovalSupport: upstreamApprovalSupportSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const hasEndpoint =
      typeof value.runtimeActionEndpoint === "string" &&
      value.runtimeActionEndpoint.trim().length > 0;
    const hasTargets =
      Array.isArray(value.runtimeActionTargets) &&
      value.runtimeActionTargets.length > 0;

    if (hasEndpoint && !isLoopbackRuntimeActionEndpoint(value.runtimeActionEndpoint)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtimeActionEndpoint"],
        message:
          "Runtime action endpoints must stay on a local loopback URL such as http://127.0.0.1:9191/runtime-actions.",
      });
    }

    if (hasEndpoint !== hasTargets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasEndpoint ? ["runtimeActionTargets"] : ["runtimeActionEndpoint"],
        message:
          "runtimeActionEndpoint and runtimeActionTargets must be declared together for sidecar runtime bridges.",
      });
    }

    if (hasTargets && !hasDeclaredRuntimeActionTarget(value, "send_prompt")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtimeActionTargets"],
        message:
          "External sidecar bridges currently support only send_prompt, so runtimeActionTargets must include send_prompt.",
      });
    }
  });
const ingestPayloadSchema = z.object({
  agent: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    platform: platformSchema,
    workspacePath: z.string().min(1),
    state: runStateSchema,
    health: healthSchema,
    attention: attentionSchema,
    lastHeartbeatAt: z.string().min(1).nullable().optional(),
    lastEventAt: z.string().min(1).nullable().optional(),
    currentRunId: z.string().min(1).nullable().optional(),
    sessionMetadata: sessionMetadataSchema.nullable().optional(),
  }),
  run: z
    .object({
      id: z.string().min(1),
      agentId: z.string().min(1).optional(),
      title: z.string().min(1),
      state: runStateSchema,
      health: healthSchema,
      attention: attentionSchema,
      waitingReason: waitingReasonSchema.nullable().optional(),
      progress: runProgressSchema.nullable().optional(),
      lastEventAt: z.string().min(1).optional(),
      createdAt: z.string().min(1).optional(),
    })
    .optional(),
  event: z
    .object({
      type: eventTypeSchema,
      runId: z.string().min(1).nullable().optional(),
      state: runStateSchema.nullable().optional(),
      attention: attentionSchema.optional(),
      message: z.string().min(1),
      sourceEventId: z.string().min(1).nullable().optional(),
      correlationId: z.string().min(1).nullable().optional(),
      createdAt: z.string().min(1).optional(),
    })
    .optional(),
});

const OPEN_SOCKET_STATE = 1;

interface SocketLike {
  readyState: number;
  send(payload: string): void;
}

interface RouteContext {
  service: ControlPlaneService;
  notifier: HubNotifier;
  mockRuntimeEnabled: boolean;
  copilotSessionDiscoveryEnabled: boolean;
  claudeCodeSessionDiscoveryEnabled: boolean;
  geminiCliSessionDiscoveryEnabled: boolean;
  openClawSessionDiscoveryEnabled: boolean;
  openClawRuntime: OpenClawRuntimeService;
  approvalOperator: ApprovalOperatorService;
  runtimeOperator: RuntimeOperatorService;
  terminalLifecycle: TerminalLifecycleService;
  workspaceOperator: WorkspaceOperatorService;
  desktopNotificationsEnabled: boolean;
  desktopNotificationsSupported: boolean;
}

interface RunActionParams {
  id: string;
}

interface ResourcePolicyParams {
  platform: AgentPlatform;
}

interface RunActionBody {
  action: RunAction;
}

interface AgentRuntimeActionBody extends AgentRuntimeActionRequest {}
interface TaskRuntimeActionBody extends AgentRuntimeActionRequest {}
interface SessionActionBody extends SessionActionRequest {}
interface ResourcePolicyBody extends ResourcePolicyUpdateRequest {}
interface TaskPriorityBody extends TaskPriorityRequest {}
interface TaskAssignmentBody extends TaskAssignmentRequest {}
interface TaskHandoffBody extends TaskHandoffRequest {}
interface TaskHandoffActionBody extends TaskHandoffActionRequest {}
interface AgentWorkspaceActionBody extends AgentWorkspaceActionRequest {}
interface ApprovalResolveBody {
  decision: ApprovalDecision;
}

function sendMessage(socket: SocketLike, message: HubStreamMessage): void {
  if (socket.readyState !== OPEN_SOCKET_STATE) {
    return;
  }

  socket.send(JSON.stringify(message));
}

export async function registerRoutes(
  app: FastifyInstance,
  context: RouteContext,
): Promise<void> {
  app.get("/health", async () => {
    const snapshot = context.service.getSnapshot();

    return {
      ok: true,
      generatedAt: snapshot.generatedAt,
      mockRuntimeEnabled: context.mockRuntimeEnabled,
      copilotSessionDiscoveryEnabled: context.copilotSessionDiscoveryEnabled,
      claudeCodeSessionDiscoveryEnabled: context.claudeCodeSessionDiscoveryEnabled,
      geminiCliSessionDiscoveryEnabled: context.geminiCliSessionDiscoveryEnabled,
      openClawSessionDiscoveryEnabled: context.openClawSessionDiscoveryEnabled,
      desktopNotificationsEnabled: context.desktopNotificationsEnabled,
      desktopNotificationsSupported: context.desktopNotificationsSupported,
      counts: {
        agents: snapshot.agents.length,
        runs: snapshot.runs.length,
        inbox: snapshot.inbox.length,
        approvals: snapshot.approvals.length,
        events: snapshot.events.length,
      },
    };
  });

  app.get("/api/integrations", async (request) => {
    const origin = `${request.protocol}://${request.headers.host ?? "127.0.0.1:8787"}`;

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      mockRuntimeEnabled: context.mockRuntimeEnabled,
      integrations: [
        {
          id: "generic-http-ingest",
          name: "Generic HTTP ingest",
          method: "POST",
          path: "/api/ingest",
          endpoint: `${origin}/api/ingest`,
          description:
            "Upsert an agent, optionally upsert one run, and optionally append one event from any local script or sidecar adapter. A sidecar can also declare a local loopback runtime-action callback through agent.sessionMetadata.",
          examplePayload: {
            agent: {
              id: "agent-local-sidecar",
              name: "Local Sidecar",
              platform: "generic",
              workspacePath: "/Users/emosama/workspace/some-repo",
              state: "running",
              health: "healthy",
              attention: "info",
              currentRunId: "run-local-task",
              sessionMetadata: {
                runtimeActionEndpoint: "http://127.0.0.1:9191/runtime-actions",
                runtimeActionTargets: ["send_prompt"],
              },
            },
            run: {
              id: "run-local-task",
              title: "Stream local status into Agent Hub",
              state: "running",
              health: "healthy",
              attention: "info",
              progress: {
                phase: "executing",
                percent: 45,
                message: "Publishing status updates from a local helper process.",
              },
            },
            event: {
              type: "run.progress",
              message: "Local sidecar pushed a progress update into the hub.",
            },
          },
        },
        {
          id: "reference-sidecar-kit",
          name: "Reference sidecar kit",
          method: "POST",
          path: "/api/ingest",
          endpoint: `${origin}/api/ingest`,
          description:
            "Zero-dependency Node sidecar that can publish one-shot status, watch a local JSON state file, and optionally expose a loopback send_prompt bridge back into the runtime.",
          entrypoint: "examples/reference-sidecar.mjs",
          exampleStateFile: "examples/reference-sidecar.example.json",
          quickStartCommand:
            "npm run adapter:reference -- --agent-id agent-local-sidecar --name \"Local Sidecar\" --workspace /Users/emosama/workspace/some-repo",
          watchCommand:
            "npm run adapter:reference -- --state-file ./examples/reference-sidecar.example.json --watch --interval-ms 3000",
          runtimeBridgeCommand:
            "npm run adapter:reference -- --state-file ./examples/reference-sidecar.example.json --watch --action-port 9191",
        },
      ],
    };
  });

  app.get("/api/references", async () => ({
    ok: true,
    generatedAt: new Date().toISOString(),
    references: referenceCatalog,
  }));

  app.get("/api/snapshot", async () => context.service.getSnapshot());
  app.get("/api/agents", async () => context.service.listAgents());
  app.get("/api/projects", async () => context.service.listProjects());
  app.get("/api/sessions", async () => context.service.listSessions());
  app.get("/api/tasks", async () => context.service.listTasks());
  app.get("/api/resources", async () => context.service.listResources());
  app.get("/api/runs", async () => context.service.listRuns());
  app.get("/api/inbox", async () => context.service.listInbox());
  app.get("/api/approvals", async () => ({
    ok: true,
    generatedAt: new Date().toISOString(),
    approvals: context.service.listApprovals(),
    bridge: context.service.getApprovalBridgeStatus("openclaw"),
  }));
  app.get("/api/events", async () => context.service.listEvents());

  app.post<{ Body: AgentIngestPayload }>("/api/ingest", async (request) => {
    const body = ingestPayloadSchema.parse(request.body);
    const result = context.service.ingestUpdate(body);

    if (result.event) {
      context.notifier.publish({
        type: "event",
        data: result.event,
      });
    }

    context.notifier.publish({
      type: "snapshot",
      data: result.snapshot,
    });

    return result;
  });

  app.post<{ Params: RunActionParams; Body: RunActionBody }>(
    "/api/runs/:id/actions",
    async (request) => {
      const body = runActionSchema.parse(request.body);
      const result = context.service.applyRunAction(
        request.params.id,
        body.action,
      );

      context.notifier.publish({
        type: "event",
        data: result.event,
      });
      context.notifier.publish({
        type: "snapshot",
        data: result.snapshot,
      });

      return {
        ok: true,
        run: result.run,
        event: result.event,
        snapshot: result.snapshot,
      };
    },
  );

  app.post<{ Params: RunActionParams; Body: AgentRuntimeActionBody }>(
    "/api/agents/:id/runtime-actions",
    async (request) => {
      const body = runtimeActionSchema.parse(request.body);
      const agent = context.service.getAgent(request.params.id);

      if (!agent) {
        throw new ControlPlaneError(
          404,
          `Agent ${request.params.id} was not found.`,
        );
      }

      const actionStartedAt = new Date().toISOString();
      const result = await context.runtimeOperator.runAgentRuntimeAction(agent, body);
      const acknowledgement = context.service.recordRuntimeActionAcknowledgement({
        agentId: agent.id,
        message: result.message,
        runId: result.runId ?? agent.currentRunId,
        target: body.target,
        timestamp: actionStartedAt,
      });

      if (acknowledgement) {
        context.notifier.publish({
          type: "event",
          data: acknowledgement,
        });
      }

      context.openClawRuntime.syncNow();
      const snapshot = context.service.getSnapshot();
      context.notifier.publish({
        type: "snapshot",
        data: snapshot,
      });
      context.openClawRuntime.scheduleSync(2_000);

      return {
        ...result,
        event: acknowledgement,
        message: acknowledgement?.message ?? result.message,
        snapshot,
      };
    },
  );

  app.post<{ Params: RunActionParams; Body: TaskRuntimeActionBody }>(
    "/api/tasks/:id/runtime-actions",
    async (request) => {
      const body = runtimeActionSchema.parse(request.body);
      const task = context.service.getTask(request.params.id);

      if (!task) {
        throw new ControlPlaneError(
          404,
          `Task ${request.params.id} was not found.`,
        );
      }

      const agent = context.service.getAgent(task.agentId);

      if (!agent) {
        throw new ControlPlaneError(
          404,
          `Agent ${task.agentId} for task ${request.params.id} was not found.`,
        );
      }

      const actionStartedAt = new Date().toISOString();
      const result = await context.runtimeOperator.runAgentRuntimeAction(agent, body);
      const acknowledgement = context.service.recordRuntimeActionAcknowledgement({
        agentId: agent.id,
        message: result.message,
        runId: result.runId ?? task.runId,
        target: body.target,
        timestamp: actionStartedAt,
      });

      if (acknowledgement) {
        context.notifier.publish({
          type: "event",
          data: acknowledgement,
        });
      }

      context.openClawRuntime.syncNow();
      const snapshot = context.service.getSnapshot();
      context.notifier.publish({
        type: "snapshot",
        data: snapshot,
      });
      context.openClawRuntime.scheduleSync(2_000);

      return {
        ...result,
        taskId: task.id,
        event: acknowledgement,
        message: acknowledgement?.message ?? result.message,
        snapshot,
      };
    },
  );

  app.post<{ Params: RunActionParams; Body: SessionActionBody }>(
    "/api/sessions/:id/actions",
    async (request) => {
      const body = sessionActionSchema.parse(request.body);
      const session = context.service.getSession(request.params.id);

      if (!session) {
        throw new ControlPlaneError(
          404,
          `Session ${request.params.id} was not found.`,
        );
      }

      const agent = context.service.getAgent(session.agentId);

      if (!agent) {
        throw new ControlPlaneError(
          404,
          `Agent ${session.agentId} for session ${request.params.id} was not found.`,
        );
      }

      const actionStartedAt = new Date().toISOString();
      const correlationId = randomUUID();

      if (body.target === "dispatch_text") {
        const result = await context.runtimeOperator.runAgentRuntimeAction(agent, {
          target: "send_prompt",
          message: body.message,
        });
        const acknowledgement = context.service.recordSessionActionAcknowledgement({
          agentId: agent.id,
          message: result.message,
          runId: result.runId ?? session.currentRunId,
          target: "dispatch_text",
          timestamp: actionStartedAt,
          correlationId,
        });

        if (acknowledgement) {
          context.notifier.publish({
            type: "event",
            data: acknowledgement,
          });
        }

        context.openClawRuntime.syncNow();
        const snapshot = context.service.getSnapshot();
        context.notifier.publish({
          type: "snapshot",
          data: snapshot,
        });
        context.openClawRuntime.scheduleSync(2_000);

        return {
          ok: true,
          sessionId: session.id,
          agentId: agent.id,
          target: "dispatch_text" as const,
          runId: result.runId ?? session.currentRunId,
          event: acknowledgement,
          message: acknowledgement?.message ?? result.message,
          snapshot,
        };
      }

      const result = await context.terminalLifecycle.attachToSession(agent, session);
      const acknowledgement = context.service.recordSessionActionAcknowledgement({
        agentId: agent.id,
        message: result.message,
        runId: result.runId ?? session.currentRunId,
        target: "attach_terminal",
        timestamp: actionStartedAt,
        correlationId,
      });

      if (acknowledgement) {
        context.notifier.publish({
          type: "event",
          data: acknowledgement,
        });
      }

      const snapshot = context.service.getSnapshot();
      context.notifier.publish({
        type: "snapshot",
        data: snapshot,
      });

      return {
        ...result,
        event: acknowledgement,
        message: acknowledgement?.message ?? result.message,
        snapshot,
      };
    },
  );

  app.post<{ Params: RunActionParams; Body: TaskPriorityBody }>(
    "/api/tasks/:id/priority",
    async (request) => {
      const body = taskPrioritySchema.parse(request.body);
      const result = context.service.setTaskPriority(request.params.id, body.priority);

      if (result.event) {
        context.notifier.publish({
          type: "event",
          data: result.event,
        });
      }

      context.notifier.publish({
        type: "snapshot",
        data: result.snapshot,
      });

      return {
        ok: true,
        ...result,
      };
    },
  );

  app.post<{ Params: RunActionParams; Body: TaskAssignmentBody }>(
    "/api/tasks/:id/assignment",
    async (request) => {
      const body = taskAssignmentSchema.parse(request.body);
      const result = context.service.setTaskOwner(request.params.id, body.owner);

      if (result.event) {
        context.notifier.publish({
          type: "event",
          data: result.event,
        });
      }

      context.notifier.publish({
        type: "snapshot",
        data: result.snapshot,
      });

      return {
        ok: true,
        ...result,
      };
    },
  );

  app.post<{ Params: RunActionParams; Body: TaskHandoffBody }>(
    "/api/tasks/:id/handoff",
    async (request) => {
      const body = taskHandoffSchema.parse(request.body);
      const result = context.service.setTaskHandoff(
        request.params.id,
        body.targetOwner,
        body.targetOwner ? body.note ?? null : null,
      );

      if (result.event) {
        context.notifier.publish({
          type: "event",
          data: result.event,
        });
      }

      context.notifier.publish({
        type: "snapshot",
        data: result.snapshot,
      });

      return {
        ok: true,
        ...result,
      };
    },
  );

  app.post<{ Params: RunActionParams; Body: TaskHandoffActionBody }>(
    "/api/tasks/:id/handoff-actions",
    async (request) => {
      const body = taskHandoffActionSchema.parse(request.body);

      if (body.action !== "complete") {
        throw new ControlPlaneError(400, `Unsupported handoff action ${body.action}.`);
      }

      const result = context.service.completeTaskHandoff(request.params.id);

      if (result.event) {
        context.notifier.publish({
          type: "event",
          data: result.event,
        });
      }

      context.notifier.publish({
        type: "snapshot",
        data: result.snapshot,
      });

      return {
        ok: true,
        ...result,
      };
    },
  );

  app.post<{ Params: ResourcePolicyParams; Body: ResourcePolicyBody }>(
    "/api/resources/:platform/policy",
    async (request) => {
      const platform = platformSchema.parse(request.params.platform);
      const body = resourcePolicyUpdateSchema.parse(request.body);
      const result = context.service.setResourcePolicy(platform, body.slotLimit);

      context.notifier.publish({
        type: "snapshot",
        data: result.snapshot ?? context.service.getSnapshot(),
      });

      return result;
    },
  );

  app.post<{ Params: RunActionParams; Body: ApprovalResolveBody }>(
    "/api/approvals/:id/resolve",
    async (request) => {
      const body = approvalResolveSchema.parse(request.body);
      const approval = context.service.getApproval(request.params.id);

      if (!approval) {
        throw new ControlPlaneError(
          404,
          `Approval ${request.params.id} was not found.`,
        );
      }

      const result = await context.approvalOperator.resolveApproval(
        approval,
        body.decision,
      );

      context.notifier.publish({
        type: "snapshot",
        data: result.snapshot,
      });

      return result;
    },
  );

  app.post<{ Params: RunActionParams; Body: AgentWorkspaceActionBody }>(
    "/api/agents/:id/workspace-actions",
    async (request) => {
      const body = workspaceActionSchema.parse(request.body);
      const agent = context.service.getAgent(request.params.id);

      if (!agent) {
        throw new ControlPlaneError(
          404,
          `Agent ${request.params.id} was not found.`,
        );
      }

      return context.workspaceOperator.runAgentWorkspaceAction(agent, body.target);
    },
  );

  app.get("/ws", { websocket: true }, (socket) => {
    sendMessage(socket, {
      type: "snapshot",
      data: context.service.getSnapshot(),
    });

    const unsubscribe = context.notifier.subscribe((message) => {
      sendMessage(socket, message);
    });

    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
    socket.on(
      "message",
      (payload: string | Buffer | ArrayBuffer | Buffer[]) => {
        if (String(payload) === "snapshot") {
          sendMessage(socket, {
            type: "snapshot",
            data: context.service.getSnapshot(),
          });
        }
      },
    );
  });
}
