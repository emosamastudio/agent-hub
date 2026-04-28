import assert from "node:assert/strict";

import BetterSqlite3 from "better-sqlite3";

import { applySchema } from "../db/schema.js";
import { AgentRepository } from "../repositories/agent-repository.js";
import { ApprovalRepository } from "../repositories/approval-repository.js";
import { EventRepository } from "../repositories/event-repository.js";
import { InboxRepository } from "../repositories/inbox-repository.js";
import { ResourcePolicyRepository } from "../repositories/resource-policy-repository.js";
import { RunRepository } from "../repositories/run-repository.js";
import { TaskAssignmentRepository } from "../repositories/task-assignment-repository.js";
import { TaskHandoffRepository } from "../repositories/task-handoff-repository.js";
import { TaskPriorityRepository } from "../repositories/task-priority-repository.js";
import type { AgentDescriptor, AgentRun } from "../shared-types.js";
import { ControlPlaneService } from "../services/control-plane-service.js";
import {
  buildOpenClawLifecycleEvent,
  deriveOpenClawGatewayObservation,
  deriveOpenClawUpstreamApprovalSupport,
} from "../services/openclaw-runtime.js";

function createControlPlaneService() {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);

  return {
    db,
    service: new ControlPlaneService(
      db,
      new AgentRepository(db),
      new RunRepository(db),
      new InboxRepository(db),
      new ApprovalRepository(db),
      new EventRepository(db),
      new ResourcePolicyRepository(db),
      new TaskAssignmentRepository(db),
      new TaskPriorityRepository(db),
      new TaskHandoffRepository(db),
    ),
  };
}

function buildAgent(): AgentDescriptor {
  return {
    id: "openclaw-agent-silijian",
    name: "OpenClaw · 司礼监",
    platform: "openclaw",
    workspacePath: "/Users/emosama/workspace",
    state: "waiting_input",
    health: "degraded",
    attention: "action_needed",
    lastHeartbeatAt: "2026-04-12T18:54:07.307Z",
    lastEventAt: "2026-04-12T18:54:07.307Z",
    currentRunId: "openclaw-run-silijian",
    sessionMetadata: {
      sessionId: "session-before",
      sessionKey: "agent:silijian:main",
      gatewayReachable: true,
      gatewayUrl: "wss://127.0.0.1:18789",
    },
  };
}

function buildRun(): AgentRun {
  return {
    id: "openclaw-run-silijian",
    agentId: "openclaw-agent-silijian",
    title: "OpenClaw agent · 司礼监",
    state: "waiting_input",
    health: "degraded",
    attention: "action_needed",
    waitingReason: "human_review",
    progress: {
      phase: "waiting",
      percent: null,
      message: "Waiting for the next live operator input.",
    },
    lastEventAt: "2026-04-12T18:54:07.307Z",
    createdAt: "2026-04-12T18:02:41.877Z",
  };
}

function verifyGatewayTruthFallback() {
  const derived = deriveOpenClawGatewayObservation({
    healthProbeReachable: true,
    statusGatewayError:
      "connect failed: self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
    statusGatewayReachable: false,
    statusGatewayUrl: "wss://127.0.0.1:18789",
  });

  assert.equal(derived.gatewayReachable, true);
  assert.equal(derived.gatewayUrl, "wss://127.0.0.1:18789");
  assert.equal(derived.gatewayError, null);
}

function verifyRuntimeActionAuditTrail() {
  const { db, service } = createControlPlaneService();
  const agent = buildAgent();
  const run = buildRun();

  service.ingestUpdate({
    agent,
    run,
  });

  const event = service.recordRuntimeActionAcknowledgement({
    agentId: agent.id,
    message:
      "OpenClaw accepted a prompt dispatch for OpenClaw · 司礼监 on live session session-before.",
    runId: run.id,
    target: "send_prompt",
    timestamp: "2026-04-12T18:54:07.307Z",
  });

  assert.ok(event);
  assert.equal(event.type, "runtime.action_acknowledged");
  assert.equal(event.runId, run.id);
  assert.match(event.message, /waiting for the next upstream runtime event/i);

  const snapshot = service.getSnapshot();
  const storedRun = snapshot.runs.find((entry) => entry.id === run.id);
  assert.ok(storedRun);
  assert.equal(storedRun.state, "waiting_input");
  assert.equal(storedRun.waitingReason, "human_review");
  assert.equal(snapshot.events[0]?.type, "runtime.action_acknowledged");

  db.close();
}

function verifyLifecycleEvents() {
  const sessionRotation = buildOpenClawLifecycleEvent({
    activeSession: {
      key: "agent:silijian:main",
      sessionId: "session-after",
      updatedAt: "2026-04-12T18:55:27.400Z",
      acpBacked: false,
    },
    discoveredAgent: {
      runtimeAgentId: "silijian",
      displayName: "司礼监",
      workspacePath: "/Users/emosama/workspace",
      state: "running",
      health: "degraded",
      attention: "action_needed",
      lastHeartbeatAt: "2026-04-12T18:55:27.400Z",
      lastEventAt: "2026-04-12T18:55:27.400Z",
      createdAt: "2026-04-12T18:02:41.877Z",
      progressPhase: "active session",
      progressMessage: "Latest persisted session activity at 2026-04-12T18:55:27.400Z.",
      discoveredEventType: "session.opened",
      discoveredEventMessage: "Observed local OpenClaw agent 司礼监.",
    },
    existingAgent: buildAgent(),
    gatewayReachable: true,
    gatewayUrl: "wss://127.0.0.1:18789",
    lastEventAt: "2026-04-12T18:55:27.400Z",
  });

  assert.equal(sessionRotation?.type, "session.opened");
  assert.match(sessionRotation?.message ?? "", /session-before/);
  assert.match(sessionRotation?.message ?? "", /session-after/);

  const gatewayRecovered = buildOpenClawLifecycleEvent({
    activeSession: undefined,
    discoveredAgent: {
      runtimeAgentId: "silijian",
      displayName: "司礼监",
      workspacePath: "/Users/emosama/workspace",
      state: "running",
      health: "degraded",
      attention: "action_needed",
      lastHeartbeatAt: "2026-04-12T18:55:27.400Z",
      lastEventAt: "2026-04-12T18:55:27.400Z",
      createdAt: "2026-04-12T18:02:41.877Z",
      progressPhase: "active session",
      progressMessage: "Latest persisted session activity at 2026-04-12T18:55:27.400Z.",
      discoveredEventType: "session.opened",
      discoveredEventMessage: "Observed local OpenClaw agent 司礼监.",
    },
    existingAgent: {
      ...buildAgent(),
      sessionMetadata: {
        ...buildAgent().sessionMetadata,
        gatewayReachable: false,
      },
    },
    gatewayReachable: true,
    gatewayUrl: "wss://127.0.0.1:18789",
    lastEventAt: "2026-04-12T18:55:27.400Z",
  });

  assert.equal(gatewayRecovered?.type, "agent.recovered");
  assert.match(gatewayRecovered?.message ?? "", /reachable again/i);
}

function verifyUpstreamApprovalTruth() {
  const nonAcpSession = deriveOpenClawUpstreamApprovalSupport({
    activeSession: {
      key: "agent:silijian:main",
      sessionId: "session-current",
      updatedAt: "2026-04-12T19:04:21.828Z",
      acpBacked: false,
    },
  });

  assert.deepEqual(nonAcpSession, {
    supported: false,
    code: "openclaw-session-not-acp",
  });

  const acpSession = deriveOpenClawUpstreamApprovalSupport({
    activeSession: {
      key: "agent:silijian:acp:main",
      sessionId: "session-acp",
      updatedAt: "2026-04-12T19:04:21.828Z",
      acpBacked: true,
    },
  });

  assert.deepEqual(acpSession, {
    supported: true,
    code: "openclaw-acp-session",
  });
}

verifyGatewayTruthFallback();
verifyRuntimeActionAuditTrail();
verifyLifecycleEvents();
verifyUpstreamApprovalTruth();

console.log("OpenClaw runtime regression harness passed.");
