import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import WebSocket, { type RawData } from "ws";

import { ApprovalRepository } from "../repositories/approval-repository.js";
import { EventRepository } from "../repositories/event-repository.js";
import {
  deriveProjectDescriptorId,
  deriveSessionDescriptorId,
} from "../shared-types.js";
import type {
  AgentEvent,
  ApprovalBridgeStatus,
  ApprovalItem,
} from "../shared-types.js";
import { ControlPlaneService } from "./control-plane-service.js";
import type { HubNotifier } from "./notifier.js";

const execFileAsync = promisify(execFile);
const CONNECT_DELAY_MS = 750;
const MAX_RECONNECT_DELAY_MS = 15_000;
const LIVE_ONLY_COMPLETENESS = "live-only" as const;
const OPENCLAW_CONNECT_CLIENT_ID = "cli";
const OPENCLAW_CONNECT_CLIENT_MODE = "cli";
const OPENCLAW_CONNECT_SCOPES = ["operator.admin", "operator.approvals"];
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
]);

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

type GatewayStatusPayload = {
  rpc?: {
    ok?: boolean;
    url?: string;
  };
  gateway?: {
    port?: number;
  };
  config?: {
    cli?: {
      controlUi?: {
        allowedOrigins?: string[];
      };
    };
    daemon?: {
      controlUi?: {
        allowedOrigins?: string[];
      };
    };
  };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type ConnectChallengePayload = {
  nonce?: string;
  ts?: number;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

type ExecApprovalRequestPayload = {
  command: string;
  commandArgv?: string[];
  cwd?: string | null;
  host?: string | null;
  nodeId?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  envKeys?: string[];
  systemRunPlan?: Record<string, unknown> | null;
  systemRunBinding?: Record<string, unknown> | null;
};

type ExecApprovalRequested = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

type ExecApprovalResolved = {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
  resolvedBy?: string | null;
  ts: number;
};

type OpenClawDeviceIdentityRecord = {
  deviceId?: string;
  publicKeyPem?: string;
  privateKeyPem?: string;
};

type OpenClawDeviceAuthStore = {
  tokens?: {
    operator?: {
      token?: string;
    };
  };
};

type OpenClawDeviceAuthContext = {
  deviceId: string;
  publicKey: string;
  privateKeyPem: string;
  token: string | null;
};

interface OpenClawApprovalBridgeServiceOptions {
  enabled: boolean;
  logger: LoggerLike;
  notifier: HubNotifier;
  service: ControlPlaneService;
  approvals: ApprovalRepository;
  events: EventRepository;
  openclawBin: string;
  openClawStateDir: string;
}

export class OpenClawApprovalBridgeService {
  readonly enabled: boolean;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private stopped = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectRequestId: string | null = null;
  private lastError: string | null = null;
  private lastEventAt: string | null = null;
  private observedSince: string | null = null;
  private currentUrl: string | null = null;
  private connectNonce: string | null = null;
  private bridgeSessionId: string | null = null;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settlementWaiters = new Map<
    string,
    Set<(approval: ApprovalItem | null) => void>
  >();

  constructor(private readonly options: OpenClawApprovalBridgeServiceOptions) {
    this.enabled = options.enabled;
  }

  start(): void {
    if (!this.enabled) {
      return;
    }

    this.stopped = false;
    const now = new Date().toISOString();
    this.options.approvals.markPendingStale("openclaw", now);
    this.setBridgeStatus({
      connected: false,
      lastError: null,
      url: null,
    });
    this.publishSnapshot();
    this.scheduleReconnect(0);
  }

  stop(): void {
    this.stopped = true;

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const timer of this.expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();

    this.resolveAllWaiters(null);
    this.connectNonce = null;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  waitForSettlement(
    approvalId: string,
    timeoutMs = 1_500,
  ): Promise<ApprovalItem | null> {
    const current = this.options.service.getApproval(approvalId);
    if (current?.state !== "pending") {
      return Promise.resolve(current);
    }

    return new Promise((resolve) => {
      const onSettle = (approval: ApprovalItem | null) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        listeners?.delete(onSettle);
        if (listeners && listeners.size === 0) {
          this.settlementWaiters.delete(approvalId);
        }
        resolve(approval);
      };

      const listeners =
        this.settlementWaiters.get(approvalId) ??
        new Set<(approval: ApprovalItem | null) => void>();
      listeners.add(onSettle);
      this.settlementWaiters.set(approvalId, listeners);

      const timeoutHandle = setTimeout(() => {
        onSettle(this.options.service.getApproval(approvalId));
      }, timeoutMs);
    });
  }

  private scheduleReconnect(delayMs = this.backoffMs): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ws) {
      return;
    }

    try {
      const status = await this.loadGatewayStatus();
      const url =
        status.rpc?.ok === true && typeof status.rpc.url === "string"
          ? status.rpc.url
          : null;
      if (!url) {
        this.setBridgeStatus({
          connected: false,
          lastError: "OpenClaw gateway RPC is not reachable yet.",
          url: status.rpc?.url ?? null,
        });
        this.scheduleWithBackoff();
        return;
      }

      this.currentUrl = url;
      this.connectNonce = null;
      this.connectRequestId = null;
      this.ws = new WebSocket(url, {
        rejectUnauthorized: false,
      });
      this.ws.on("open", () => {
        this.connectTimer = setTimeout(() => {
          if (!this.connectRequestId && !this.connectNonce) {
            this.ws?.close(1008, "OpenClaw approval bridge challenge timed out.");
          }
        }, CONNECT_DELAY_MS);
      });
      this.ws.on("message", (data: RawData) => {
        this.handleMessage(String(data ?? ""));
      });
      this.ws.on("close", (code: number, reasonBuffer: Buffer) => {
        const reason = String(reasonBuffer ?? "");
        this.handleClose(code, reason);
      });
      this.ws.on("error", (error: Error) => {
        this.options.logger.warn(
          { error: describeProcessError(error) },
          "OpenClaw approval bridge socket error.",
        );
      });
    } catch (error) {
      this.options.logger.warn(
        { error: describeProcessError(error) },
        "OpenClaw approval bridge connect attempt failed.",
      );
      this.setBridgeStatus({
        connected: false,
        lastError: describeProcessError(error),
        url: this.currentUrl,
      });
      this.scheduleWithBackoff();
    }
  }

  private handleMessage(raw: string): void {
    let parsed: GatewayEventFrame | GatewayResponseFrame | null = null;

    try {
      parsed = JSON.parse(raw) as GatewayEventFrame | GatewayResponseFrame;
    } catch {
      return;
    }

    if (!parsed) {
      return;
    }

    if (parsed.type === "event") {
      if (parsed.event === "connect.challenge") {
        const challenge = parseConnectChallenge(parsed.payload);
        this.connectNonce = challenge?.nonce ?? null;
        this.sendConnectRequest();
        return;
      }

      if (parsed.event === "exec.approval.requested") {
        this.handleApprovalRequested(parsed.payload);
        return;
      }

      if (parsed.event === "exec.approval.resolved") {
        this.handleApprovalResolved(parsed.payload);
      }
      return;
    }

    if (parsed.type !== "res" || parsed.id !== this.connectRequestId) {
      return;
    }

    if (!parsed.ok) {
      const message =
        parsed.error?.message ?? "OpenClaw approval bridge connect request failed.";
      this.lastError = message;
      this.options.logger.warn({ error: message }, "OpenClaw approval bridge rejected.");
      this.ws?.close(1008, message);
      return;
    }

    this.handleConnected();
  }

  private sendConnectRequest(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectRequestId) {
      return;
    }

    const nonce = this.connectNonce?.trim() ?? "";
    if (!nonce) {
      return;
    }

    let deviceAuth: OpenClawDeviceAuthContext;
    try {
      deviceAuth = loadOpenClawDeviceAuthContext(this.options.openClawStateDir);
    } catch (error) {
      const message = describeProcessError(error);
      this.lastError = message;
      this.options.logger.warn(
        { error: message },
        "OpenClaw approval bridge could not load device identity.",
      );
      this.ws.close(1008, message);
      return;
    }

    const signedAt = Date.now();
    const token = deviceAuth.token;
    const payload = buildDeviceAuthPayloadV2({
      deviceId: deviceAuth.deviceId,
      clientId: OPENCLAW_CONNECT_CLIENT_ID,
      clientMode: OPENCLAW_CONNECT_CLIENT_MODE,
      role: "operator",
      scopes: OPENCLAW_CONNECT_SCOPES,
      signedAtMs: signedAt,
      token,
      nonce,
    });
    const signature = signDevicePayload(deviceAuth.privateKeyPem, payload);

    this.connectRequestId = randomUUID();
    this.ws.send(
      JSON.stringify({
        type: "req",
        id: this.connectRequestId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: OPENCLAW_CONNECT_CLIENT_ID,
            version: "agent-hub",
            platform: process.platform,
            mode: OPENCLAW_CONNECT_CLIENT_MODE,
            instanceId: randomUUID(),
          },
          role: "operator",
          scopes: OPENCLAW_CONNECT_SCOPES,
          caps: [],
          userAgent: "agent-hub-approval-bridge",
          locale: "en-US",
          auth: token
            ? {
                token,
                deviceToken: token,
              }
            : undefined,
          device: {
            id: deviceAuth.deviceId,
            publicKey: deviceAuth.publicKey,
            signature,
            signedAt,
            nonce,
          },
        },
      }),
    );
  }

  private handleConnected(): void {
    this.backoffMs = 1_000;
    this.lastError = null;
    this.bridgeSessionId = randomUUID();
    this.observedSince = new Date().toISOString();
    this.options.approvals.markPendingStale("openclaw", this.observedSince);
    for (const timer of this.expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
    this.setBridgeStatus({
      connected: true,
      lastError: null,
      url: this.currentUrl,
    });
    this.publishSnapshot();
  }

  private handleClose(code: number, reason: string): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    this.ws = null;
    this.connectRequestId = null;

    if (this.stopped) {
      return;
    }

    const message = reason || `gateway closed (${code})`;
    this.lastError = message;
    this.setBridgeStatus({
      connected: false,
      lastError: message,
      url: this.currentUrl,
    });
    this.publishSnapshot();
    this.scheduleWithBackoff();
  }

  private handleApprovalRequested(payload: unknown): void {
    const requested = parseExecApprovalRequested(payload);
    if (!requested) {
      return;
    }

    const observedAt = new Date().toISOString();
    this.lastEventAt = observedAt;
    const agentId = this.resolveHubAgentId(
      requested.request.agentId ?? null,
      requested.request.sessionKey ?? null,
    );
    const runId = this.resolveHubRunId(agentId, requested.request.agentId ?? null);
    const approval: ApprovalItem = {
      id: requested.id,
      platform: "openclaw",
      state: "pending",
      attention: "action_needed",
      agentId,
      runId,
      upstreamAgentId: requested.request.agentId ?? null,
      sessionKey: requested.request.sessionKey ?? null,
      host: requested.request.host ?? null,
      nodeId: requested.request.nodeId ?? null,
      request: {
        command: requested.request.command,
        commandArgv: requested.request.commandArgv ?? null,
        cwd: requested.request.cwd ?? null,
        host: requested.request.host ?? null,
        nodeId: requested.request.nodeId ?? null,
        security: requested.request.security ?? null,
        ask: requested.request.ask ?? null,
        agentId: requested.request.agentId ?? null,
        resolvedPath: requested.request.resolvedPath ?? null,
        sessionKey: requested.request.sessionKey ?? null,
        envKeys: requested.request.envKeys ?? null,
        systemRunPlan: requested.request.systemRunPlan ?? null,
        systemRunBinding: requested.request.systemRunBinding ?? null,
      },
      createdAt: new Date(requested.createdAtMs).toISOString(),
      expiresAt: new Date(requested.expiresAtMs).toISOString(),
      observedAt,
      resolvedAt: null,
      resolvedBy: null,
      decision: null,
      bridgeSessionId: this.bridgeSessionId,
    };

    this.options.approvals.upsert(approval);
    this.scheduleExpiry(approval.id, requested.expiresAtMs);

    const event = this.buildApprovalRequestedEvent(approval);
    if (event) {
      this.options.events.insert(event);
      this.options.notifier.publish({
        type: "event",
        data: event,
      });
    }

    this.setBridgeStatus({
      connected: true,
      lastError: null,
      url: this.currentUrl,
    });
    this.publishSnapshot();
  }

  private handleApprovalResolved(payload: unknown): void {
    const resolved = parseExecApprovalResolved(payload);
    if (!resolved) {
      return;
    }

    this.clearExpiry(resolved.id);
    const observedAt = new Date().toISOString();
    this.lastEventAt = observedAt;
    const normalizedDecision =
      resolved.decision === "allow-once" || resolved.decision === "allow-always"
        ? "allow-once"
        : "deny";
    const approval = this.options.approvals.markResolved(
      resolved.id,
      normalizedDecision,
      resolved.resolvedBy ?? null,
      new Date(resolved.ts).toISOString(),
      observedAt,
    );

    if (!approval) {
      this.resolveWaiters(resolved.id, null);
      return;
    }

    const event = this.buildApprovalResolvedEvent(approval);
    if (event) {
      this.options.events.insert(event);
      this.options.notifier.publish({
        type: "event",
        data: event,
      });
    }

    const runTransition = this.options.service.reconcileApprovalResolution(
      approval.runId,
      normalizedDecision,
      approval.resolvedAt ?? observedAt,
    );
    if (runTransition) {
      this.options.notifier.publish({
        type: "event",
        data: runTransition.event,
      });
    }

    this.publishSnapshot();
    this.resolveWaiters(resolved.id, approval);
  }

  private scheduleExpiry(approvalId: string, expiresAtMs: number): void {
    this.clearExpiry(approvalId);

    const delay = Math.max(0, expiresAtMs - Date.now() + 500);
    const timer = setTimeout(() => {
      this.expiryTimers.delete(approvalId);
      const observedAt = new Date().toISOString();
      this.lastEventAt = observedAt;
      const approval = this.options.approvals.markExpired(
        approvalId,
        observedAt,
        observedAt,
      );
      if (!approval) {
        this.resolveWaiters(approvalId, null);
        return;
      }

      const event = this.buildApprovalExpiredEvent(approval);
      if (event) {
        this.options.events.insert(event);
        this.options.notifier.publish({
          type: "event",
          data: event,
        });
      }

      this.publishSnapshot();
      this.resolveWaiters(approvalId, approval);
    }, delay);

    this.expiryTimers.set(approvalId, timer);
  }

  private clearExpiry(approvalId: string): void {
    const timer = this.expiryTimers.get(approvalId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.expiryTimers.delete(approvalId);
  }

  private resolveHubAgentId(
    upstreamAgentId: string | null,
    sessionKey: string | null,
  ): string | null {
    if (upstreamAgentId) {
      const explicitId = `openclaw-agent-${upstreamAgentId}`;
      if (this.options.service.getAgent(explicitId)) {
        return explicitId;
      }
    }

    if (!sessionKey) {
      return null;
    }

    const agent = this.options
      .service
      .listAgents()
      .find(
        (entry) =>
          entry.platform === "openclaw" &&
          entry.sessionMetadata?.sessionKey === sessionKey,
      );

    return agent?.id ?? null;
  }

  private resolveHubRunId(
    agentId: string | null,
    upstreamAgentId: string | null,
  ): string | null {
    if (agentId) {
      return this.options.service.getAgent(agentId)?.currentRunId ?? null;
    }

    if (!upstreamAgentId) {
      return null;
    }

    const candidateRunId = `openclaw-run-${upstreamAgentId}`;
    return this.options
      .service
      .listRuns()
      .some((run) => run.id === candidateRunId)
      ? candidateRunId
      : null;
  }

  private buildApprovalRequestedEvent(approval: ApprovalItem): AgentEvent | null {
    if (!approval.agentId) {
      return null;
    }

    const agent = this.options.service.getAgent(approval.agentId);
    if (!agent) {
      return null;
    }

    return {
      id: randomUUID(),
      runId: approval.runId,
      agentId: approval.agentId,
      sessionKey: deriveSessionDescriptorId(approval.agentId),
      projectId: deriveProjectDescriptorId(agent.workspacePath, approval.agentId),
      sourceEventId: null,
      correlationId: null,
      type: "approval.requested",
      state: null,
      attention: "action_needed",
      message: `OpenClaw approval requested for ${approval.request.command}.`,
      createdAt: approval.observedAt,
    };
  }

  private buildApprovalResolvedEvent(approval: ApprovalItem): AgentEvent | null {
    if (!approval.agentId) {
      return null;
    }

    const agent = this.options.service.getAgent(approval.agentId);
    if (!agent) {
      return null;
    }

    return {
      id: randomUUID(),
      runId: approval.runId,
      agentId: approval.agentId,
      sessionKey: deriveSessionDescriptorId(approval.agentId),
      projectId: deriveProjectDescriptorId(agent.workspacePath, approval.agentId),
      sourceEventId: null,
      correlationId: null,
      type: "approval.resolved",
      state: null,
      attention: "info",
      message: `OpenClaw approval ${approval.id} resolved as ${approval.decision ?? "unknown"}.`,
      createdAt: approval.resolvedAt ?? approval.observedAt,
    };
  }

  private buildApprovalExpiredEvent(approval: ApprovalItem): AgentEvent | null {
    if (!approval.agentId) {
      return null;
    }

    const agent = this.options.service.getAgent(approval.agentId);
    if (!agent) {
      return null;
    }

    return {
      id: randomUUID(),
      runId: approval.runId,
      agentId: approval.agentId,
      sessionKey: deriveSessionDescriptorId(approval.agentId),
      projectId: deriveProjectDescriptorId(agent.workspacePath, approval.agentId),
      sourceEventId: null,
      correlationId: null,
      type: "approval.expired",
      state: null,
      attention: "info",
      message: `OpenClaw approval ${approval.id} expired before it was resolved.`,
      createdAt: approval.resolvedAt ?? approval.observedAt,
    };
  }

  private resolveWaiters(approvalId: string, approval: ApprovalItem | null): void {
    const listeners = this.settlementWaiters.get(approvalId);
    if (!listeners) {
      return;
    }

    this.settlementWaiters.delete(approvalId);
    for (const listener of listeners) {
      listener(approval);
    }
  }

  private resolveAllWaiters(approval: ApprovalItem | null): void {
    for (const approvalId of this.settlementWaiters.keys()) {
      this.resolveWaiters(approvalId, approval);
    }
  }

  private setBridgeStatus(
    params: Pick<ApprovalBridgeStatus, "connected" | "lastError" | "url">,
  ): void {
    this.options.service.setApprovalBridgeStatus({
      platform: "openclaw",
      connected: params.connected,
      liveOnly: true,
      completeness: LIVE_ONLY_COMPLETENESS,
      observedSince: this.observedSince,
      lastEventAt: this.lastEventAt,
      lastError: params.lastError,
      url: params.url,
    });
  }

  private publishSnapshot(): void {
    this.options.notifier.publish({
      type: "snapshot",
      data: this.options.service.getSnapshot(),
    });
  }

  private scheduleWithBackoff(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(Math.round(this.backoffMs * 1.7), MAX_RECONNECT_DELAY_MS);
    this.scheduleReconnect(delay);
  }

  private async loadGatewayStatus(): Promise<GatewayStatusPayload> {
    const { stdout } = await execFileAsync(
      this.options.openclawBin,
      ["gateway", "status", "--json"],
      {
        env: this.buildOpenClawEnv(),
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error("OpenClaw gateway status returned empty output.");
    }

    return JSON.parse(trimmed) as GatewayStatusPayload;
  }

  private buildOpenClawEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const stateDir = this.options.openClawStateDir.trim();

    if (stateDir) {
      env.OPENCLAW_STATE_DIR = stateDir;
      env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
    }

    return env;
  }
}

function parseConnectChallenge(payload: unknown): ConnectChallengePayload | null {
  if (!isRecord(payload)) {
    return null;
  }

  const nonce = typeof payload.nonce === "string" ? payload.nonce.trim() : "";
  if (!nonce) {
    return null;
  }

  return {
    nonce,
    ts: typeof payload.ts === "number" ? payload.ts : undefined,
  };
}

function loadOpenClawDeviceAuthContext(
  openClawStateDir: string,
): OpenClawDeviceAuthContext {
  const devicePath = path.join(openClawStateDir, "identity", "device.json");
  const authPath = path.join(openClawStateDir, "identity", "device-auth.json");
  const device = JSON.parse(
    readFileSync(devicePath, "utf8"),
  ) as OpenClawDeviceIdentityRecord;

  const deviceId = typeof device.deviceId === "string" ? device.deviceId.trim() : "";
  const publicKeyPem =
    typeof device.publicKeyPem === "string" ? device.publicKeyPem.trim() : "";
  const privateKeyPem =
    typeof device.privateKeyPem === "string" ? device.privateKeyPem.trim() : "";
  if (!deviceId || !publicKeyPem || !privateKeyPem) {
    throw new Error("OpenClaw device identity is incomplete.");
  }

  let token: string | null = null;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as OpenClawDeviceAuthStore;
    token =
      typeof auth.tokens?.operator?.token === "string"
        ? auth.tokens.operator.token.trim() || null
        : null;
  } catch {
    token = null;
  }

  return {
    deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(publicKeyPem),
    privateKeyPem,
    token,
  };
}

function buildDeviceAuthPayloadV2(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
}): string {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ].join("|");
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  return sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem))
    .toString("base64url");
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  const exported = createPublicKey(publicKeyPem).export({
    format: "der",
    type: "spki",
  });
  const spki = Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
  if (
    spki.length <= ED25519_SPKI_PREFIX.length ||
    !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error("OpenClaw device public key format is not Ed25519 SPKI.");
  }

  return spki.subarray(ED25519_SPKI_PREFIX.length).toString("base64url");
}

function parseExecApprovalRequested(payload: unknown): ExecApprovalRequested | null {
  if (!isRecord(payload)) {
    return null;
  }

  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const request = payload.request;
  const createdAtMs =
    typeof payload.createdAtMs === "number" ? payload.createdAtMs : 0;
  const expiresAtMs =
    typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : 0;
  if (!id || !isRecord(request) || !createdAtMs || !expiresAtMs) {
    return null;
  }

  const command =
    typeof request.command === "string" ? request.command.trim() : "";
  if (!command) {
    return null;
  }

  return {
    id,
    request: {
      command,
      commandArgv: normalizeStringArray(request.commandArgv),
      cwd: normalizeString(request.cwd),
      host: normalizeString(request.host),
      nodeId: normalizeString(request.nodeId),
      security: normalizeString(request.security),
      ask: normalizeString(request.ask),
      agentId: normalizeString(request.agentId),
      resolvedPath: normalizeString(request.resolvedPath),
      sessionKey: normalizeString(request.sessionKey),
      envKeys: normalizeStringArray(request.envKeys),
      systemRunPlan: isRecord(request.systemRunPlan)
        ? request.systemRunPlan
        : null,
      systemRunBinding: isRecord(request.systemRunBinding)
        ? request.systemRunBinding
        : null,
    },
    createdAtMs,
    expiresAtMs,
  };
}

function parseExecApprovalResolved(payload: unknown): ExecApprovalResolved | null {
  if (!isRecord(payload)) {
    return null;
  }

  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const decision =
    payload.decision === "allow-once" ||
    payload.decision === "allow-always" ||
    payload.decision === "deny"
      ? payload.decision
      : null;
  const ts = typeof payload.ts === "number" ? payload.ts : 0;
  if (!id || !decision || !ts) {
    return null;
  }

  return {
    id,
    decision,
    resolvedBy: normalizeString(payload.resolvedBy),
    ts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return entries.length > 0 ? entries : undefined;
}

function describeProcessError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
