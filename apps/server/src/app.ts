import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { serverConfig } from "./config.js";
import { createDatabase } from "./db/index.js";
import { registerRoutes } from "./http/routes.js";
import { AgentRepository } from "./repositories/agent-repository.js";
import { ApprovalRepository } from "./repositories/approval-repository.js";
import { EventRepository } from "./repositories/event-repository.js";
import { InboxRepository } from "./repositories/inbox-repository.js";
import { ResourcePolicyRepository } from "./repositories/resource-policy-repository.js";
import { RunRepository } from "./repositories/run-repository.js";
import { TaskAssignmentRepository } from "./repositories/task-assignment-repository.js";
import { TaskHandoffRepository } from "./repositories/task-handoff-repository.js";
import { TaskPriorityRepository } from "./repositories/task-priority-repository.js";
import { ApprovalOperatorService } from "./services/approval-operator.js";
import {
  ControlPlaneError,
  ControlPlaneService,
} from "./services/control-plane-service.js";
import { ClaudeCodeRuntimeService } from "./services/claude-code-runtime.js";
import { CopilotSessionRuntimeService } from "./services/copilot-session-runtime.js";
import { DesktopNotificationService } from "./services/desktop-notifications.js";
import { GeminiCliRuntimeService } from "./services/gemini-cli-runtime.js";
import { MockRuntimeService } from "./services/mock-runtime.js";
import { HubNotifier } from "./services/notifier.js";
import { OpenClawApprovalBridgeService } from "./services/openclaw-approval-bridge.js";
import { OpenClawRuntimeService } from "./services/openclaw-runtime.js";
import {
  ClaudeCodeRuntimeActionBridge,
  CopilotSessionRuntimeActionBridge,
  GeminiCliRuntimeActionBridge,
  OpenClawRuntimeActionBridge,
  RuntimeOperatorService,
  SidecarRuntimeActionBridge,
} from "./services/runtime-operator.js";
import { TerminalLifecycleService } from "./services/terminal-lifecycle.js";
import { WorkspaceOperatorService } from "./services/workspace-operator.js";

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: true,
  });
  await app.register(websocket);

  const db = createDatabase({
    dbPath: serverConfig.dbPath,
    workspaceRoot: serverConfig.workspaceRoot,
  });

  const agentRepository = new AgentRepository(db);
  const approvalRepository = new ApprovalRepository(db);
  const runRepository = new RunRepository(db);
  const inboxRepository = new InboxRepository(db);
  const eventRepository = new EventRepository(db);
  const resourcePolicyRepository = new ResourcePolicyRepository(db);
  const taskAssignmentRepository = new TaskAssignmentRepository(db);
  const taskPriorityRepository = new TaskPriorityRepository(db);
  const taskHandoffRepository = new TaskHandoffRepository(db);
  const service = new ControlPlaneService(
    db,
    agentRepository,
    runRepository,
    inboxRepository,
    approvalRepository,
    eventRepository,
    resourcePolicyRepository,
    taskAssignmentRepository,
    taskPriorityRepository,
    taskHandoffRepository,
  );

  if (!serverConfig.enableMockRuntime) {
    service.purgeSeededDemoData();
  }

  const notifier = new HubNotifier();
  const claudeCodeRuntime = new ClaudeCodeRuntimeService({
    claudeBin: serverConfig.claudeBin,
    enabled: serverConfig.enableClaudeCodeSessionDiscovery,
    logger: app.log,
    notifier,
    pollIntervalMs: serverConfig.claudeCodeSessionPollMs,
    projectsDir: serverConfig.claudeProjectsDir,
    service,
  });
  const copilotRuntime = new CopilotSessionRuntimeService({
    enabled: serverConfig.enableCopilotSessionDiscovery,
    logger: app.log,
    notifier,
    pollIntervalMs: serverConfig.copilotSessionPollMs,
    service,
    sessionStateDir: serverConfig.copilotSessionStateDir,
  });
  const geminiCliRuntime = new GeminiCliRuntimeService({
    geminiBin: serverConfig.geminiBin,
    geminiDir: serverConfig.geminiStateDir,
    enabled: serverConfig.enableGeminiCliSessionDiscovery,
    logger: app.log,
    notifier,
    pollIntervalMs: serverConfig.geminiCliSessionPollMs,
    service,
  });
  const openClawRuntime = new OpenClawRuntimeService({
    enabled: serverConfig.enableOpenClawSessionDiscovery,
    logger: app.log,
    notifier,
    pollIntervalMs: serverConfig.openClawSessionPollMs,
    service,
    openclawBin: serverConfig.openClawBin,
    stateDir: serverConfig.openClawStateDir,
  });
  const openClawApprovalBridge = new OpenClawApprovalBridgeService({
    enabled: serverConfig.enableOpenClawSessionDiscovery,
    logger: app.log,
    notifier,
    service,
    approvals: approvalRepository,
    events: eventRepository,
    openclawBin: serverConfig.openClawBin,
    openClawStateDir: serverConfig.openClawStateDir,
  });
  const desktopNotifications = new DesktopNotificationService({
    enabled: serverConfig.enableDesktopNotifications,
    cooldownMs: serverConfig.desktopNotificationCooldownMs,
    logger: app.log,
  });
  const workspaceOperator = new WorkspaceOperatorService({
    claudeProjectsDir: serverConfig.claudeProjectsDir,
    copilotSessionStateDir: serverConfig.copilotSessionStateDir,
    geminiStateDir: serverConfig.geminiStateDir,
    openClawStateDir: serverConfig.openClawStateDir,
  });
  const runtimeOperator = new RuntimeOperatorService({
    claudeBin: serverConfig.claudeBin,
    copilotBin: serverConfig.copilotBin,
    copilotSdkModulePath: serverConfig.copilotSdkModulePath,
    geminiBin: serverConfig.geminiBin,
    geminiDir: serverConfig.geminiStateDir,
    openclawBin: serverConfig.openClawBin,
    openClawStateDir: serverConfig.openClawStateDir,
    bridges: [
      new SidecarRuntimeActionBridge(),
      new ClaudeCodeRuntimeActionBridge({
        claudeBin: serverConfig.claudeBin,
      }),
      new GeminiCliRuntimeActionBridge({
        geminiBin: serverConfig.geminiBin,
        geminiDir: serverConfig.geminiStateDir,
      }),
      new CopilotSessionRuntimeActionBridge({
        copilotBin: serverConfig.copilotBin,
        copilotSdkModulePath: serverConfig.copilotSdkModulePath,
      }),
      new OpenClawRuntimeActionBridge({
        openclawBin: serverConfig.openClawBin,
        openClawStateDir: serverConfig.openClawStateDir,
      }),
    ],
  });
  const terminalLifecycle = new TerminalLifecycleService({
    claudeBin: serverConfig.claudeBin,
    geminiBin: serverConfig.geminiBin,
  });
  const approvalOperator = new ApprovalOperatorService({
    openclawBin: serverConfig.openClawBin,
    openClawStateDir: serverConfig.openClawStateDir,
    service,
    bridge: openClawApprovalBridge,
  });
  const runtime = new MockRuntimeService({
    service,
    notifier,
    simulationIntervalMs: serverConfig.simulationIntervalMs,
    heartbeatIntervalMs: serverConfig.heartbeatIntervalMs,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({
        message: "Invalid request payload.",
        issues: error.issues,
      });
      return;
    }

    if (error instanceof ControlPlaneError) {
      void reply.status(error.statusCode).send({
        message: error.message,
      });
      return;
    }

    app.log.error(error);
    void reply.status(500).send({
      message: "Internal server error.",
    });
  });

  await registerRoutes(app, {
    service,
    notifier,
    mockRuntimeEnabled: serverConfig.enableMockRuntime,
    copilotSessionDiscoveryEnabled: copilotRuntime.enabled,
    claudeCodeSessionDiscoveryEnabled: claudeCodeRuntime.enabled,
    geminiCliSessionDiscoveryEnabled: geminiCliRuntime.enabled,
    openClawSessionDiscoveryEnabled: openClawRuntime.enabled,
    openClawRuntime,
    approvalOperator,
    runtimeOperator,
    terminalLifecycle,
    workspaceOperator,
    desktopNotificationsEnabled: desktopNotifications.enabled,
    desktopNotificationsSupported: desktopNotifications.supported,
  });

  desktopNotifications.start(notifier);
  claudeCodeRuntime.start();
  copilotRuntime.start();
  geminiCliRuntime.start();
  openClawRuntime.start();
  openClawApprovalBridge.start();

  if (serverConfig.enableMockRuntime) {
    runtime.start();
  }

  app.addHook("onClose", async () => {
    desktopNotifications.stop();
    claudeCodeRuntime.stop();
    copilotRuntime.stop();
    geminiCliRuntime.stop();
    openClawRuntime.stop();
    openClawApprovalBridge.stop();
    runtime.stop();
    if (db.open) {
      db.close();
    }
  });

  return app;
}
