import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

import type {
  AgentDescriptor,
  AgentIngestEventInput,
  AgentSessionMetadata,
} from "../shared-types.js";
import type { ControlPlaneService } from "./control-plane-service.js";
import type { HubNotifier } from "./notifier.js";

const OPENCLAW_AGENT_PREFIX = "openclaw-agent-";
const OPENCLAW_RUN_PREFIX = "openclaw-run-";
const STATUS_TIMEOUT_MS = 4_000;
const RECENT_ACTIVITY_WINDOW_MS = 15 * 60 * 1_000;

interface OpenClawRuntimeOptions {
  enabled: boolean;
  logger: FastifyBaseLogger;
  notifier: HubNotifier;
  pollIntervalMs: number;
  service: ControlPlaneService;
  openclawBin: string;
  stateDir: string;
}

interface OpenClawGatewayStatus {
  reachable?: boolean;
  url?: string;
  error?: string | null;
}

interface OpenClawGatewayServiceStatus {
  installed?: boolean;
  loadedText?: string;
}

interface OpenClawHeartbeatAgent {
  agentId?: string;
  enabled?: boolean;
  every?: string;
}

interface OpenClawStatusAgent {
  id?: string;
  name?: string;
  workspaceDir?: string;
  bootstrapPending?: boolean;
  sessionsPath?: string;
  sessionsCount?: number;
  lastUpdatedAt?: number | null;
}

interface OpenClawStatusSnapshot {
  runtimeVersion?: string;
  gateway?: OpenClawGatewayStatus;
  gatewayService?: OpenClawGatewayServiceStatus;
  heartbeat?: {
    defaultAgentId?: string;
    agents?: OpenClawHeartbeatAgent[];
  };
  agents?: {
    defaultId?: string;
    agents?: OpenClawStatusAgent[];
  };
}

interface OpenClawSessionsSnapshot {
  stores?: OpenClawSessionStore[];
  sessions?: OpenClawSessionEntry[];
}

interface OpenClawSessionStore {
  agentId?: string;
  path?: string;
}

interface OpenClawSessionEntry {
  key?: string;
  updatedAt?: number | null;
  sessionId?: string;
  agentId?: string;
}

interface ActiveOpenClawSession {
  key: string;
  sessionId: string | null;
  updatedAt: string | null;
  acpBacked: boolean | null;
}

interface ActiveOpenClawProcess {
  pid: number;
}

interface DiscoveredOpenClawAgent {
  runtimeAgentId: string;
  displayName: string;
  workspacePath: string;
  state: "ready" | "running";
  health: "healthy" | "degraded";
  attention: "silent" | "info" | "action_needed";
  lastHeartbeatAt: string | null;
  lastEventAt: string | null;
  createdAt: string | null;
  progressPhase: string;
  progressMessage: string;
  discoveredEventType: "agent.registered" | "session.opened";
  discoveredEventMessage: string;
}

export class OpenClawRuntimeService {
  private interval: NodeJS.Timeout | null = null;
  private lastFingerprint: string | null = null;
  private lastWarningSignature: string | null = null;

  constructor(private readonly options: OpenClawRuntimeOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  start(): void {
    if (!this.enabled || this.interval) {
      return;
    }

    this.sync();
    this.interval = setInterval(() => {
      this.sync();
    }, this.options.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  syncNow(): void {
    this.sync();
  }

  scheduleSync(delayMs: number): void {
    const timer = setTimeout(() => {
      this.sync();
    }, delayMs);
    timer.unref();
  }

  private sync(): void {
    const activeProcesses = listActiveOpenClawProcesses();
    let sessionsByAgent = new Map<string, ActiveOpenClawSession>();

    let status: OpenClawStatusSnapshot | null = null;
    try {
      status = readOpenClawStatus(this.options.openclawBin, this.options.stateDir);
      this.lastWarningSignature = null;
    } catch (error) {
      this.warnOnce("Failed to read OpenClaw status", error);

      if (activeProcesses.length > 0) {
        return;
      }
    }

    try {
      sessionsByAgent = readOpenClawSessions(
        this.options.openclawBin,
        this.options.stateDir,
      );
    } catch (error) {
      this.warnOnce("Failed to read OpenClaw sessions", error);
    }

    const knownOpenClawAgents = this.options.service
      .listAgents()
      .filter((agent) => agent.id.startsWith(OPENCLAW_AGENT_PREFIX));

    if (!status) {
      this.removeInactiveAgents(knownOpenClawAgents.map((agent) => agent.id));
      return;
    }

    const gatewayHealthProbeReachable =
      status.gateway?.reachable === true || !normalizeString(status.gateway?.url)
        ? false
        : probeOpenClawGatewayHealth(this.options.openclawBin, this.options.stateDir);
    const { gatewayReachable, gatewayUrl, gatewayError } =
      deriveOpenClawGatewayObservation({
        healthProbeReachable: gatewayHealthProbeReachable,
        statusGatewayError: status.gateway?.error,
        statusGatewayReachable: status.gateway?.reachable,
        statusGatewayUrl: status.gateway?.url,
      });
    const gatewayServiceInstalled = status.gatewayService?.installed === true;
    const gatewayServiceLoadedText =
      normalizeString(status.gatewayService?.loadedText) ?? null;
    const gatewayServiceLoaded = deriveGatewayServiceLoaded(
      gatewayServiceLoadedText,
    );
    const runtimeActive = gatewayReachable || activeProcesses.length > 0;

    if (!runtimeActive) {
      this.removeInactiveAgents(knownOpenClawAgents.map((agent) => agent.id));
      return;
    }

    const discoveredAgents = discoverOpenClawAgents(status, {
      gatewayError,
      gatewayReachable,
      gatewayUrl,
      hasActiveProcess: activeProcesses.length > 0,
      stateDir: this.options.stateDir,
    });
    const fingerprint = JSON.stringify({
      hasActiveProcess: activeProcesses.length > 0,
      gatewayReachable,
      gatewayUrl,
      gatewayError,
      runtimeVersion: status.runtimeVersion ?? null,
      agents: discoveredAgents.map((agent) => [
        agent.runtimeAgentId,
        agent.displayName,
        agent.workspacePath,
        agent.state,
        agent.health,
        agent.attention,
        agent.lastHeartbeatAt,
        agent.lastEventAt,
        agent.createdAt,
        agent.progressPhase,
        agent.progressMessage,
        sessionsByAgent.get(agent.runtimeAgentId)?.key ?? null,
        sessionsByAgent.get(agent.runtimeAgentId)?.sessionId ?? null,
        sessionsByAgent.get(agent.runtimeAgentId)?.acpBacked ?? null,
      ]),
    });

    if (fingerprint === this.lastFingerprint) {
      return;
    }

    this.lastFingerprint = fingerprint;

    const knownAgentById = new Map(knownOpenClawAgents.map((agent) => [agent.id, agent]));
    const runLookup = new Map(
      this.options.service
        .listRuns()
        .filter((run) => run.id.startsWith(OPENCLAW_RUN_PREFIX))
        .map((run) => [run.id, run] as const),
    );
    const activeAgentIds = new Set<string>();

    for (const discoveredAgent of discoveredAgents) {
      const agentId = `${OPENCLAW_AGENT_PREFIX}${discoveredAgent.runtimeAgentId}`;
      const runId = `${OPENCLAW_RUN_PREFIX}${discoveredAgent.runtimeAgentId}`;
      const existingRun = runLookup.get(runId);
      const fallbackTimestamp = new Date().toISOString();
      const activeSession = sessionsByAgent.get(discoveredAgent.runtimeAgentId);
      const existingAgent = knownAgentById.get(agentId);
      const createdAt =
        existingRun?.createdAt ??
        discoveredAgent.createdAt ??
        discoveredAgent.lastEventAt ??
        fallbackTimestamp;
      const lastEventAt =
        discoveredAgent.lastEventAt ?? existingRun?.lastEventAt ?? createdAt;
      const lastHeartbeatAt =
        discoveredAgent.lastHeartbeatAt ?? existingRun?.lastEventAt ?? createdAt;

      activeAgentIds.add(agentId);

      const result = this.options.service.ingestUpdate({
        agent: {
          id: agentId,
          name: `OpenClaw · ${discoveredAgent.displayName}`,
          platform: "openclaw",
          workspacePath: discoveredAgent.workspacePath,
          state: discoveredAgent.state,
          health: discoveredAgent.health,
          attention: discoveredAgent.attention,
          currentRunId: runId,
          lastHeartbeatAt,
          lastEventAt,
          sessionMetadata: {
            sessionId: activeSession?.sessionId ?? null,
            sessionKey: activeSession?.key ?? null,
            toolVersion: normalizeString(status.runtimeVersion) ?? null,
            updatedAt: activeSession?.updatedAt ?? null,
            gatewayUrl,
            gatewayReachable,
            gatewayError,
            gatewayServiceInstalled,
            gatewayServiceLoaded,
            gatewayServiceLoadedText,
            upstreamApprovalSupport: deriveOpenClawUpstreamApprovalSupport({
              activeSession,
            }),
          },
        },
        run: {
          id: runId,
          title: `OpenClaw agent · ${discoveredAgent.displayName}`,
          state: discoveredAgent.state,
          health: discoveredAgent.health,
          attention: discoveredAgent.attention,
          progress: {
            phase: discoveredAgent.progressPhase,
            percent: null,
            message: discoveredAgent.progressMessage,
          },
          lastEventAt,
          createdAt,
        },
        event: buildOpenClawLifecycleEvent({
          activeSession,
          discoveredAgent,
          existingAgent,
          gatewayReachable,
          gatewayUrl,
          lastEventAt,
        }),
      });

      if (result.event) {
        this.options.notifier.publish({
          type: "event",
          data: result.event,
        });
      }
    }

    for (const agent of knownOpenClawAgents) {
      if (activeAgentIds.has(agent.id)) {
        continue;
      }

      const runtimeAgentId = agent.id.slice(OPENCLAW_AGENT_PREFIX.length);
      const runId = `${OPENCLAW_RUN_PREFIX}${runtimeAgentId}`;
      const result = this.options.service.removeRuntimeSession(
        agent.id,
        runId,
        `${agent.name} is no longer active on this machine.`,
      );

      if (result.event) {
        this.options.notifier.publish({
          type: "event",
          data: result.event,
        });
      }
    }

    this.options.notifier.publish({
      type: "snapshot",
      data: this.options.service.getSnapshot(),
    });
  }

  private removeInactiveAgents(agentIds: string[]): void {
    const fingerprint = JSON.stringify({ active: false, agents: [] });
    if (fingerprint === this.lastFingerprint) {
      return;
    }

    this.lastFingerprint = fingerprint;

    for (const agentId of agentIds) {
      const runtimeAgentId = agentId.slice(OPENCLAW_AGENT_PREFIX.length);
      const runId = `${OPENCLAW_RUN_PREFIX}${runtimeAgentId}`;
      const result = this.options.service.removeRuntimeSession(
        agentId,
        runId,
        `${agentId} is no longer active on this machine.`,
      );

      if (result.event) {
        this.options.notifier.publish({
          type: "event",
          data: result.event,
        });
      }
    }

    if (agentIds.length > 0) {
      this.options.notifier.publish({
        type: "snapshot",
        data: this.options.service.getSnapshot(),
      });
    }
  }

  private warnOnce(message: string, error: unknown): void {
    const signature = `${message}:${normalizeErrorSignature(error)}`;
    if (signature === this.lastWarningSignature) {
      return;
    }

    this.lastWarningSignature = signature;
    this.options.logger.warn({ error }, message);
  }
}

function discoverOpenClawAgents(
  status: OpenClawStatusSnapshot,
  options: {
    gatewayError: string | null;
    gatewayReachable: boolean;
    gatewayUrl: string | null;
    hasActiveProcess: boolean;
    stateDir: string;
  },
): DiscoveredOpenClawAgent[] {
  const defaultAgentId =
    normalizeString(status.agents?.defaultId) ??
    normalizeString(status.heartbeat?.defaultAgentId);
  const heartbeatByAgent = new Map<string, OpenClawHeartbeatAgent>();

  for (const agent of status.heartbeat?.agents ?? []) {
    const agentId = normalizeString(agent.agentId);
    if (!agentId) {
      continue;
    }
    heartbeatByAgent.set(agentId, agent);
  }

  const relevantAgents = pickRelevantStatusAgents(status, heartbeatByAgent, defaultAgentId);
  return relevantAgents.map((agent) =>
    buildDiscoveredAgent(agent, {
      defaultAgentId,
      gatewayError: options.gatewayError,
      gatewayReachable: options.gatewayReachable,
      gatewayUrl: options.gatewayUrl,
      hasActiveProcess: options.hasActiveProcess,
      heartbeat: heartbeatByAgent.get(agent.id),
      runtimeVersion: normalizeString(status.runtimeVersion) ?? null,
      stateDir: options.stateDir,
    }),
  );
}

export function buildOpenClawLifecycleEvent(params: {
  activeSession: ActiveOpenClawSession | undefined;
  discoveredAgent: DiscoveredOpenClawAgent;
  existingAgent: AgentDescriptor | undefined;
  gatewayReachable: boolean;
  gatewayUrl: string | null;
  lastEventAt: string;
}): AgentIngestEventInput | undefined {
  if (!params.existingAgent) {
    return {
      type: params.discoveredAgent.discoveredEventType,
      attention:
        params.discoveredAgent.attention === "action_needed"
          ? "info"
          : params.discoveredAgent.attention,
      message: params.discoveredAgent.discoveredEventMessage,
      createdAt: params.lastEventAt,
    };
  }

  const previousSessionId =
    normalizeString(params.existingAgent.sessionMetadata?.sessionId) ?? null;
  const nextSessionId = params.activeSession?.sessionId ?? null;

  if (nextSessionId && nextSessionId !== previousSessionId) {
    return {
      type: "session.opened",
      attention: "info",
      message: previousSessionId
        ? `OpenClaw session rotated for ${params.discoveredAgent.displayName}. Session id changed from ${previousSessionId} to ${nextSessionId}.`
        : `OpenClaw opened a live session for ${params.discoveredAgent.displayName}. Session id ${nextSessionId}.`,
      createdAt: params.lastEventAt,
    };
  }

  const previousGatewayReachable =
    params.existingAgent.sessionMetadata?.gatewayReachable === true;
  if (!previousGatewayReachable && params.gatewayReachable) {
    return {
      type: "agent.recovered",
      attention: "info",
      message: params.gatewayUrl
        ? `OpenClaw gateway ${params.gatewayUrl} is reachable again for ${params.discoveredAgent.displayName}.`
        : `OpenClaw gateway reachability recovered for ${params.discoveredAgent.displayName}.`,
      createdAt: new Date().toISOString(),
    };
  }

  return undefined;
}

export function deriveOpenClawUpstreamApprovalSupport(params: {
  activeSession: ActiveOpenClawSession | undefined;
}): AgentSessionMetadata["upstreamApprovalSupport"] {
  if (!params.activeSession?.key) {
    return {
      supported: false,
      code: "openclaw-session-unavailable",
    };
  }

  if (params.activeSession.acpBacked === true) {
    return {
      supported: true,
      code: "openclaw-acp-session",
    };
  }

  if (params.activeSession.acpBacked === false) {
    return {
      supported: false,
      code: "openclaw-session-not-acp",
    };
  }

  return {
    supported: false,
    code: "openclaw-session-unavailable",
  };
}

export function deriveOpenClawGatewayObservation(params: {
  healthProbeReachable: boolean;
  statusGatewayError: unknown;
  statusGatewayReachable: boolean | undefined;
  statusGatewayUrl: unknown;
}): {
  gatewayReachable: boolean;
  gatewayUrl: string | null;
  gatewayError: string | null;
} {
  let gatewayReachable = params.statusGatewayReachable === true;
  const gatewayUrl = normalizeString(params.statusGatewayUrl) ?? null;
  let gatewayError = normalizeString(params.statusGatewayError) ?? null;

  if (!gatewayReachable && gatewayUrl && params.healthProbeReachable) {
    gatewayReachable = true;
    gatewayError = null;
  }

  return {
    gatewayReachable,
    gatewayUrl,
    gatewayError,
  };
}

function buildDiscoveredAgent(
  agent: Required<Pick<OpenClawStatusAgent, "id">> &
    Pick<
      OpenClawStatusAgent,
      "name" | "workspaceDir" | "bootstrapPending" | "sessionsCount" | "lastUpdatedAt"
    >,
  options: {
    defaultAgentId: string | null;
    gatewayError: string | null;
    gatewayReachable: boolean;
    gatewayUrl: string | null;
    hasActiveProcess: boolean;
    heartbeat: OpenClawHeartbeatAgent | undefined;
    runtimeVersion: string | null;
    stateDir: string;
  },
): DiscoveredOpenClawAgent {
  const displayName = normalizeString(agent.name) ?? agent.id;
  const workspacePath =
    normalizeString(agent.workspaceDir) ??
    path.join(
      options.stateDir,
      agent.id === options.defaultAgentId ? "workspace" : `workspace-${agent.id}`,
    );
  const lastUpdatedAtIso = toIsoTimestamp(agent.lastUpdatedAt);
  const recentSession = isRecentActivity(agent.lastUpdatedAt);
  const heartbeatEvery = normalizeString(options.heartbeat?.every) ?? null;
  const heartbeatEnabled = options.heartbeat?.enabled === true;
  const sessionsCount = normalizeNumber(agent.sessionsCount) ?? 0;
  const bootstrapPending = agent.bootstrapPending === true;

  if (!options.gatewayReachable && options.hasActiveProcess) {
    return {
      runtimeAgentId: agent.id,
      displayName,
      workspacePath,
      state: "running",
      health: "degraded",
      attention: "action_needed",
      lastHeartbeatAt: lastUpdatedAtIso,
      lastEventAt: lastUpdatedAtIso,
      createdAt: lastUpdatedAtIso,
      progressPhase: "gateway unavailable",
      progressMessage: buildGatewayUnavailableMessage({
        gatewayError: options.gatewayError,
        gatewayUrl: options.gatewayUrl,
        runtimeVersion: options.runtimeVersion,
      }),
      discoveredEventType: "agent.registered",
      discoveredEventMessage: `Observed local OpenClaw agent “${displayName}” while its gateway endpoint is currently unavailable.`,
    };
  }

  if (recentSession) {
    return {
      runtimeAgentId: agent.id,
      displayName,
      workspacePath,
      state: "running",
      health: bootstrapPending ? "degraded" : "healthy",
      attention: bootstrapPending ? "action_needed" : "info",
      lastHeartbeatAt: lastUpdatedAtIso,
      lastEventAt: lastUpdatedAtIso,
      createdAt: lastUpdatedAtIso,
      progressPhase: "active session",
      progressMessage: buildRecentSessionMessage({
        bootstrapPending,
        heartbeatEnabled,
        heartbeatEvery,
        lastUpdatedAtIso,
        runtimeVersion: options.runtimeVersion,
        sessionsCount,
        workspacePath,
      }),
      discoveredEventType: "session.opened",
      discoveredEventMessage: `Discovered live OpenClaw agent “${displayName}” with recent local session activity.`,
    };
  }

  return {
    runtimeAgentId: agent.id,
    displayName,
    workspacePath,
    state: "ready",
    health: bootstrapPending ? "degraded" : "healthy",
    attention: bootstrapPending ? "action_needed" : "silent",
    lastHeartbeatAt: lastUpdatedAtIso,
    lastEventAt: lastUpdatedAtIso,
    createdAt: lastUpdatedAtIso,
    progressPhase: bootstrapPending ? "bootstrap pending" : "standing by",
    progressMessage: buildReadyMessage({
      bootstrapPending,
      heartbeatEnabled,
      heartbeatEvery,
      runtimeVersion: options.runtimeVersion,
      sessionsCount,
      workspacePath,
    }),
    discoveredEventType: "agent.registered",
    discoveredEventMessage: `Discovered configured OpenClaw agent “${displayName}” from local status metadata.`,
  };
}

function pickRelevantStatusAgents(
  status: OpenClawStatusSnapshot,
  heartbeatByAgent: Map<string, OpenClawHeartbeatAgent>,
  defaultAgentId: string | null,
): Array<
  Required<Pick<OpenClawStatusAgent, "id">> &
    Pick<
      OpenClawStatusAgent,
      "name" | "workspaceDir" | "bootstrapPending" | "sessionsCount" | "lastUpdatedAt"
    >
> {
  const agents = (status.agents?.agents ?? [])
    .map((agent) => normalizeStatusAgent(agent))
    .filter(
      (
        agent,
      ): agent is Required<Pick<OpenClawStatusAgent, "id">> &
        Pick<
          OpenClawStatusAgent,
          "name" | "workspaceDir" | "bootstrapPending" | "sessionsCount" | "lastUpdatedAt"
        > => agent !== null,
    );

  const relevant = agents.filter((agent) => {
    if (agent.id === defaultAgentId) {
      return true;
    }

    if (heartbeatByAgent.get(agent.id)?.enabled === true) {
      return true;
    }

    if ((normalizeNumber(agent.sessionsCount) ?? 0) > 0) {
      return true;
    }

    if (normalizeNumber(agent.lastUpdatedAt) !== null) {
      return true;
    }

    return agent.bootstrapPending === true;
  });

  if (relevant.length > 0) {
    return relevant;
  }

  if (defaultAgentId) {
    const defaultAgent = agents.find((agent) => agent.id === defaultAgentId);
    if (defaultAgent) {
      return [defaultAgent];
    }
  }

  return agents.slice(0, 1);
}

function normalizeStatusAgent(
  agent: OpenClawStatusAgent,
): (Required<Pick<OpenClawStatusAgent, "id">> &
  Pick<
    OpenClawStatusAgent,
    "name" | "workspaceDir" | "bootstrapPending" | "sessionsCount" | "lastUpdatedAt"
  >) | null {
  const id = normalizeString(agent.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeString(agent.name) ?? undefined,
    workspaceDir: normalizeString(agent.workspaceDir) ?? undefined,
    bootstrapPending: agent.bootstrapPending === true,
    sessionsCount: normalizeNumber(agent.sessionsCount) ?? 0,
    lastUpdatedAt: normalizeNumber(agent.lastUpdatedAt),
  };
}

function buildGatewayUnavailableMessage(params: {
  gatewayError: string | null;
  gatewayUrl: string | null;
  runtimeVersion: string | null;
}): string {
  const parts = [
    params.runtimeVersion ? `OpenClaw ${params.runtimeVersion}.` : "OpenClaw runtime detected.",
    params.gatewayUrl
      ? `Gateway ${params.gatewayUrl} is not reachable from local status right now.`
      : "Gateway is not reachable from local status right now.",
  ];

  if (params.gatewayError) {
    parts.push(`Latest local status error: ${params.gatewayError}.`);
  }

  return parts.join(" ");
}

function buildRecentSessionMessage(params: {
  bootstrapPending: boolean;
  heartbeatEnabled: boolean;
  heartbeatEvery: string | null;
  lastUpdatedAtIso: string | null;
  runtimeVersion: string | null;
  sessionsCount: number;
  workspacePath: string;
}): string {
  const parts = [
    params.runtimeVersion ? `OpenClaw ${params.runtimeVersion}.` : "OpenClaw gateway reachable.",
    `Workspace ${params.workspacePath}.`,
    params.lastUpdatedAtIso
      ? `Latest persisted session activity at ${params.lastUpdatedAtIso}.`
      : "Recent local session activity detected.",
    `Stored sessions: ${params.sessionsCount}.`,
  ];

  if (params.bootstrapPending) {
    parts.push("Bootstrap files are still pending for this agent workspace.");
  }

  parts.push(
    params.heartbeatEnabled
      ? `Heartbeat ${params.heartbeatEvery ?? "enabled"}.`
      : "Heartbeat currently disabled.",
  );

  return parts.join(" ");
}

function buildReadyMessage(params: {
  bootstrapPending: boolean;
  heartbeatEnabled: boolean;
  heartbeatEvery: string | null;
  runtimeVersion: string | null;
  sessionsCount: number;
  workspacePath: string;
}): string {
  const parts = [
    params.runtimeVersion ? `OpenClaw ${params.runtimeVersion}.` : "OpenClaw gateway reachable.",
    `Workspace ${params.workspacePath}.`,
    params.sessionsCount > 0
      ? `Stored sessions: ${params.sessionsCount}. Waiting for the next active turn.`
      : "No persisted sessions yet. Waiting for the next active turn.",
  ];

  if (params.bootstrapPending) {
    parts.push("Bootstrap files are still pending for this agent workspace.");
  }

  parts.push(
    params.heartbeatEnabled
      ? `Heartbeat ${params.heartbeatEvery ?? "enabled"}.`
      : "Heartbeat currently disabled.",
  );

  return parts.join(" ");
}

function readOpenClawStatus(
  openclawBin: string,
  stateDir: string,
): OpenClawStatusSnapshot | null {
  const output = execFileSync(openclawBin, ["status", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: STATUS_TIMEOUT_MS,
  });
  const parsed = parseJson(output);

  if (!isOpenClawStatusSnapshot(parsed)) {
    return null;
  }

  return parsed;
}

function listActiveOpenClawProcesses(): ActiveOpenClawProcess[] {
  let output = "";

  try {
    output = execFileSync("ps", ["-axo", "pid=,comm=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  return output
    .split("\n")
    .map((line) => parsePsLine(line))
    .filter(
      (
        process,
      ): process is {
        pid: number;
        executable: string;
        command: string;
      } => process !== null && isOpenClawProcess(process.executable, process.command),
    )
    .map((process) => ({
      pid: process.pid,
    }));
}

function readOpenClawSessions(
  openclawBin: string,
  stateDir: string,
): Map<string, ActiveOpenClawSession> {
  const output = execFileSync(
    openclawBin,
    ["sessions", "--all-agents", "--json"],
    {
      cwd: stateDir,
      encoding: "utf8",
      timeout: STATUS_TIMEOUT_MS,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
    },
  );
  const parsed = parseJson(output);
  if (!isOpenClawSessionsSnapshot(parsed)) {
    throw new Error("OpenClaw sessions command returned invalid JSON.");
  }

  const storePathByAgent = new Map<string, string>();
  for (const store of parsed.stores ?? []) {
    const agentId = normalizeString(store.agentId);
    const storePath = normalizeString(store.path);
    if (!agentId || !storePath) {
      continue;
    }
    storePathByAgent.set(agentId, storePath);
  }

  const acpFlagsByStorePath = new Map<string, Map<string, boolean | null>>();
  const byAgent = new Map<string, ActiveOpenClawSession>();
  for (const entry of parsed.sessions ?? []) {
    const agentId = normalizeString(entry.agentId);
    const key = normalizeString(entry.key);
    if (!agentId || !key) {
      continue;
    }

    const updatedAtMs = normalizeNumber(entry.updatedAt);
    const existing = byAgent.get(agentId);
    const existingUpdatedAtMs = existing?.updatedAt
      ? Date.parse(existing.updatedAt)
      : Number.NEGATIVE_INFINITY;

    if (
      existing &&
      updatedAtMs !== null &&
      Number.isFinite(existingUpdatedAtMs) &&
      existingUpdatedAtMs >= updatedAtMs
    ) {
      continue;
    }

    byAgent.set(agentId, {
      key,
      sessionId: normalizeString(entry.sessionId),
      updatedAt: toIsoTimestamp(updatedAtMs),
      acpBacked: resolveOpenClawSessionAcpBacked({
        cache: acpFlagsByStorePath,
        key,
        storePath: storePathByAgent.get(agentId) ?? null,
      }),
    });
  }

  return byAgent;
}

function resolveOpenClawSessionAcpBacked(params: {
  cache: Map<string, Map<string, boolean | null>>;
  key: string;
  storePath: string | null;
}): boolean | null {
  if (!params.storePath) {
    return null;
  }

  let storeFlags = params.cache.get(params.storePath);
  if (!storeFlags) {
    storeFlags = readOpenClawSessionAcpFlags(params.storePath);
    params.cache.set(params.storePath, storeFlags);
  }

  return storeFlags.get(params.key) ?? null;
}

function readOpenClawSessionAcpFlags(storePath: string): Map<string, boolean | null> {
  const flags = new Map<string, boolean | null>();

  try {
    const raw = readFileSync(storePath, "utf8");
    const parsed = parseJson(raw);
    if (!isRecord(parsed)) {
      return flags;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        flags.set(key, null);
        continue;
      }
      flags.set(key, isRecord(value.acp));
    }
  } catch {
    return flags;
  }

  return flags;
}

function probeOpenClawGatewayHealth(openclawBin: string, stateDir: string): boolean {
  try {
    const output = execFileSync(openclawBin, ["gateway", "call", "health", "--json"], {
      cwd: stateDir,
      encoding: "utf8",
      timeout: STATUS_TIMEOUT_MS,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseJson(output);
    return isRecord(parsed) && parsed.ok === true;
  } catch {
    return false;
  }
}

function parsePsLine(
  line: string,
): { pid: number; executable: string; command: string } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) {
    return null;
  }

  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(pid)) {
    return null;
  }

  return {
    pid,
    executable: match[2] ?? "",
    command: match[3] ?? "",
  };
}

function isOpenClawProcess(executable: string, command: string): boolean {
  const normalizedExecutable = path.basename(executable).toLowerCase();
  const isGatewayCommand = /(^|\s)gateway(\s|$)/.test(command);

  if (normalizedExecutable === "openclaw-gateway") {
    return true;
  }

  if (normalizedExecutable === "openclaw") {
    return (
      isGatewayCommand &&
      /(^|\s)(\/opt\/homebrew\/bin\/openclaw|\/usr\/local\/bin\/openclaw|openclaw)(\s|$)/.test(
        command,
      )
    );
  }

  if (!["node", "bun", "tsx"].includes(normalizedExecutable)) {
    return false;
  }

  return (
    isGatewayCommand &&
    /(^|\s)([^ ]*openclaw\.mjs|[^ ]*scripts\/run-node\.mjs|[^ ]*dist\/index\.js)(\s|$)/.test(
      command,
    )
  );
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function isOpenClawStatusSnapshot(value: unknown): value is OpenClawStatusSnapshot {
  return (
    isRecord(value) &&
    (!("gateway" in value) || isRecord(value.gateway)) &&
    (!("heartbeat" in value) || isRecord(value.heartbeat)) &&
    (!("agents" in value) || isRecord(value.agents))
  );
}

function isOpenClawSessionsSnapshot(value: unknown): value is OpenClawSessionsSnapshot {
  return (
    isRecord(value) &&
    (!("sessions" in value) || Array.isArray(value.sessions)) &&
    (!("stores" in value) || Array.isArray(value.stores))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function deriveGatewayServiceLoaded(value: string | null): boolean | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "not loaded") {
    return false;
  }

  if (normalized === "unknown") {
    return null;
  }

  return true;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIsoTimestamp(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function isRecentActivity(lastUpdatedAt: number | null | undefined): boolean {
  return (
    typeof lastUpdatedAt === "number" &&
    Number.isFinite(lastUpdatedAt) &&
    Date.now() - lastUpdatedAt <= RECENT_ACTIVITY_WINDOW_MS
  );
}

function normalizeErrorSignature(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${error.message}`;
  }
  return typeof error === "string" ? error : "unknown";
}
