import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  type AgentRuntimeActionRequest,
  getAgentRuntimeActionSupport,
  type AgentDescriptor,
  type AgentRuntimeActionResult,
  type AgentRuntimeActionSupportCode,
  getAgentSourceKind,
  hasDeclaredRuntimeActionTarget,
  isLoopbackRuntimeActionEndpoint,
} from "../shared-types.js";
import { ControlPlaneError } from "./control-plane-service.js";
import {
  getGeminiControlState,
  readGeminiSessionFile,
} from "./gemini-cli-runtime.js";

const execFileAsync = promisify(execFile);
const OPENCLAW_AGENT_PREFIX = "openclaw-agent-";

interface RuntimeOperatorServiceOptions {
  claudeBin: string;
  copilotBin: string;
  copilotSdkModulePath: string;
  geminiBin: string;
  geminiDir: string;
  openclawBin: string;
  openClawStateDir: string;
  bridges?: RuntimeActionBridge[];
}

interface RuntimeActionBridge {
  canHandle(agent: AgentDescriptor, request: AgentRuntimeActionRequest): boolean;
  runAgentRuntimeAction(
    agent: AgentDescriptor,
    request: AgentRuntimeActionRequest,
  ): Promise<AgentRuntimeActionResult>;
}

interface OpenClawRuntimeActionBridgeOptions {
  openclawBin: string;
  openClawStateDir: string;
}

interface ClaudeCodeRuntimeActionBridgeOptions {
  claudeBin: string;
}

interface CopilotSessionRuntimeActionBridgeOptions {
  copilotBin: string;
  copilotSdkModulePath: string;
}

interface GeminiCliRuntimeActionBridgeOptions {
  geminiBin: string;
  geminiDir: string;
}

interface CopilotSdkSession {
  send(options: { prompt: string }): Promise<string>;
  disconnect(): Promise<void>;
}

interface CopilotSdkClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  resumeSession(
    sessionId: string,
    config: Record<string, unknown>,
  ): Promise<CopilotSdkSession>;
}

interface CopilotSdkModule {
  CopilotClient: new (options?: Record<string, unknown>) => CopilotSdkClient;
  approveAll: unknown;
}

interface CopilotSessionEventRecord {
  type?: string;
  timestamp?: string;
  data?: {
    content?: unknown;
  };
}

interface ClaudeAuthStatusResponse {
  loggedIn?: boolean;
}

interface ClaudeSessionEventRecord {
  type?: string;
  operation?: string;
  timestamp?: string;
  content?: unknown;
}

interface SidecarRuntimeActionResponse {
  ok?: boolean;
  message?: string;
}

interface OpenClawDaemonActionResponse {
  ok?: boolean;
  result?: string;
  message?: string;
  error?: string;
}

interface OpenClawPromptDispatchResponse {
  ok?: boolean;
  runId?: string;
  status?: string;
  summary?: string;
  result?: string;
  message?: string;
  error?: string;
}

interface OpenClawSessionResetResponse {
  ok?: boolean;
  key?: string;
  entry?: {
    sessionId?: string;
  };
  error?: string;
}

export class RuntimeOperatorService {
  private readonly bridges: RuntimeActionBridge[];

  constructor(private readonly options: RuntimeOperatorServiceOptions) {
    this.bridges = options.bridges ?? [
      new SidecarRuntimeActionBridge(),
      new ClaudeCodeRuntimeActionBridge({
        claudeBin: options.claudeBin,
      }),
      new GeminiCliRuntimeActionBridge({
        geminiBin: options.geminiBin,
        geminiDir: options.geminiDir,
      }),
      new CopilotSessionRuntimeActionBridge({
        copilotBin: options.copilotBin,
        copilotSdkModulePath: options.copilotSdkModulePath,
      }),
      new OpenClawRuntimeActionBridge({
        openclawBin: options.openclawBin,
        openClawStateDir: options.openClawStateDir,
      }),
    ];
  }

  async runAgentRuntimeAction(
    agent: AgentDescriptor,
    request: AgentRuntimeActionRequest,
  ): Promise<AgentRuntimeActionResult> {
    const target = request.target;
    const support = getAgentRuntimeActionSupport(agent, target);
    if (!support.supported) {
      throw new ControlPlaneError(
        409,
        describeUnsupportedRuntimeAction(agent, support.code),
      );
    }

    const bridge = this.bridges.find((candidate) =>
      candidate.canHandle(agent, request),
    );
    if (!bridge) {
      throw new ControlPlaneError(
        409,
        `Agent Hub does not have a registered runtime bridge for ${target} on ${agent.name} yet.`,
      );
    }

    return await bridge.runAgentRuntimeAction(agent, request);
  }
}

export class SidecarRuntimeActionBridge implements RuntimeActionBridge {
  canHandle(agent: AgentDescriptor, request: AgentRuntimeActionRequest): boolean {
    return (
      getAgentSourceKind(agent) === "external-ingest" &&
      request.target === "send_prompt"
    );
  }

  async runAgentRuntimeAction(
    agent: AgentDescriptor,
    request: AgentRuntimeActionRequest,
  ): Promise<AgentRuntimeActionResult> {
    switch (request.target) {
      case "send_prompt":
        return await this.dispatchSidecarPrompt(agent, request.message ?? "");
      default:
        throw new ControlPlaneError(
          409,
          `The declared sidecar bridge for ${agent.name} does not expose ${request.target} through Agent Hub yet.`,
        );
    }
  }

  private async dispatchSidecarPrompt(
    agent: AgentDescriptor,
    message: string,
  ): Promise<AgentRuntimeActionResult> {
    const endpointValue =
      agent.sessionMetadata?.runtimeActionEndpoint?.trim() ?? "";
    if (
      !isLoopbackRuntimeActionEndpoint(endpointValue) ||
      !hasDeclaredRuntimeActionTarget(agent.sessionMetadata, "send_prompt")
    ) {
      throw new ControlPlaneError(
        409,
        `Prompt dispatch is unavailable for ${agent.name} because it has not declared a usable local loopback sidecar bridge.`,
      );
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new ControlPlaneError(400, "Prompt dispatch requires a non-empty message.");
    }

    let responseText = "";
    let response:
      | {
          ok: boolean;
          status: number;
          statusText: string;
          text(): Promise<string>;
        }
      | null = null;

    try {
      response = await fetch(endpointValue, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: agent.id,
          runId: agent.currentRunId,
          sessionId: agent.sessionMetadata?.sessionId ?? null,
          target: "send_prompt",
          message: trimmedMessage,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      responseText = await response.text();
    } catch (error) {
      throw new ControlPlaneError(
        500,
        `Failed to reach the declared loopback sidecar bridge for ${agent.name}: ${describeProcessError(error)}`,
      );
    }

    if (!response?.ok) {
      throw new ControlPlaneError(
        response && response.status >= 500 ? 500 : 409,
        `The declared loopback sidecar bridge for ${agent.name} rejected prompt dispatch: ${responseText.trim() || response?.statusText || "Unknown sidecar error"}.`,
      );
    }

    const payload = parseSidecarRuntimeActionResponse(responseText);
    if (payload.ok !== true) {
      throw new ControlPlaneError(
        500,
        `The declared loopback sidecar bridge for ${agent.name} returned an invalid acknowledgement payload.`,
      );
    }

    return {
      ok: true,
      agentId: agent.id,
      target: "send_prompt",
      runId: agent.currentRunId,
      sessionId: agent.sessionMetadata?.sessionId ?? null,
      message:
        typeof payload.message === "string" && payload.message.trim().length > 0
          ? payload.message.trim()
          : `The declared loopback sidecar bridge accepted a prompt dispatch for ${agent.name}.`,
    };
  }
}

export class OpenClawRuntimeActionBridge implements RuntimeActionBridge {
  constructor(private readonly options: OpenClawRuntimeActionBridgeOptions) {}

  canHandle(agent: AgentDescriptor, _request: AgentRuntimeActionRequest): boolean {
    return getAgentSourceKind(agent) === "openclaw-status-cli";
  }

  async runAgentRuntimeAction(
    agent: AgentDescriptor,
    request: AgentRuntimeActionRequest,
  ): Promise<AgentRuntimeActionResult> {
    switch (request.target) {
      case "recover_gateway":
        return await this.recoverOpenClawGateway(agent);
      case "reset_session":
        return await this.resetOpenClawSession(agent);
      case "send_prompt":
        return await this.dispatchOpenClawPrompt(agent, request.message ?? "");
    }
  }

  private async recoverOpenClawGateway(
    agent: AgentDescriptor,
  ): Promise<AgentRuntimeActionResult> {
    if (agent.sessionMetadata?.gatewayServiceLoaded === true) {
      return await this.restartManagedOpenClawGateway(agent);
    }

    return this.launchDetachedOpenClawGateway(agent);
  }

  private async restartManagedOpenClawGateway(
    agent: AgentDescriptor,
  ): Promise<AgentRuntimeActionResult> {
    try {
      const { stdout } = await execFileAsync(
        this.options.openclawBin,
        ["gateway", "restart", "--json"],
        {
          env: this.buildOpenClawEnv(),
        },
      );
      const payload = parseOpenClawDaemonAction(stdout);

      if (payload.ok !== true) {
        throw new ControlPlaneError(
          409,
          payload.error ??
            `OpenClaw gateway recovery did not succeed for ${agent.name}.`,
        );
      }

      return {
        ok: true,
        agentId: agent.id,
        target: "recover_gateway",
        message:
          payload.message ??
          `Requested a managed OpenClaw gateway restart for ${agent.name}.`,
      };
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        throw error;
      }

      throw new ControlPlaneError(
        500,
        `Failed to restart the managed OpenClaw gateway for ${agent.name}: ${describeProcessError(error)}`,
      );
    }
  }

  private launchDetachedOpenClawGateway(
    agent: AgentDescriptor,
  ): AgentRuntimeActionResult {
    try {
      const child = spawn(
        this.options.openclawBin,
        ["gateway", "--force", "run"],
        {
          detached: true,
          env: this.buildOpenClawEnv(),
          stdio: "ignore",
        },
      );
      child.unref();

      return {
        ok: true,
        agentId: agent.id,
        target: "recover_gateway",
        message: `Launched a detached OpenClaw gateway recovery for ${agent.name}. Agent Hub will refresh the local runtime signal shortly.`,
      };
    } catch (error) {
      throw new ControlPlaneError(
        500,
        `Failed to launch a detached OpenClaw gateway recovery for ${agent.name}: ${describeProcessError(error)}`,
      );
    }
  }

  private async resetOpenClawSession(
    agent: AgentDescriptor,
  ): Promise<AgentRuntimeActionResult> {
    const sessionKey = agent.sessionMetadata?.sessionKey?.trim() ?? "";
    if (!sessionKey) {
      throw new ControlPlaneError(
        409,
        `OpenClaw session reset is unavailable for ${agent.name} because no active session key is visible.`,
      );
    }

    try {
      const { stdout } = await execFileAsync(
        this.options.openclawBin,
        [
          "gateway",
          "call",
          "sessions.reset",
          "--json",
          "--params",
          JSON.stringify({
            key: sessionKey,
            reason: "reset",
          }),
        ],
        {
          env: this.buildOpenClawEnv(),
        },
      );
      const payload = parseOpenClawSessionReset(stdout);

      if (payload.ok !== true) {
        throw new ControlPlaneError(
          409,
          payload.error ??
            `OpenClaw session reset did not succeed for ${agent.name}.`,
        );
      }

      const nextSessionId =
        typeof payload.entry?.sessionId === "string" && payload.entry.sessionId.trim()
          ? payload.entry.sessionId.trim()
          : null;

      return {
        ok: true,
        agentId: agent.id,
        target: "reset_session",
        runId: agent.currentRunId,
        sessionId: nextSessionId,
        message: nextSessionId
          ? `OpenClaw reset the live session for ${agent.name}. New session id ${nextSessionId}.`
          : `Requested an OpenClaw session reset for ${agent.name} (${sessionKey}).`,
      };
    } catch (error) {
      throw new ControlPlaneError(
        500,
        `Failed to reset the OpenClaw session for ${agent.name}: ${describeProcessError(error)}`,
      );
    }
  }

  private async dispatchOpenClawPrompt(
    agent: AgentDescriptor,
    message: string,
  ): Promise<AgentRuntimeActionResult> {
    const sessionId = agent.sessionMetadata?.sessionId?.trim() ?? "";
    if (!sessionId) {
      throw new ControlPlaneError(
        409,
        `OpenClaw prompt dispatch is unavailable for ${agent.name} because no live session id is visible.`,
      );
    }

    const runtimeAgentId = deriveOpenClawRuntimeAgentId(agent);
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new ControlPlaneError(400, "Prompt dispatch requires a non-empty message.");
    }

    try {
      const { stdout } = await execFileAsync(
        this.options.openclawBin,
        [
          "agent",
          "--agent",
          runtimeAgentId,
          "--session-id",
          sessionId,
          "--message",
          trimmedMessage,
          "--json",
        ],
        {
          env: this.buildOpenClawEnv(),
        },
      );
      const payload = parseOpenClawPromptDispatch(stdout);

      if (!isOpenClawPromptDispatchSuccess(payload)) {
        throw new ControlPlaneError(
          409,
          payload.error ??
            payload.message ??
            payload.summary ??
            `OpenClaw prompt dispatch did not succeed for ${agent.name}.`,
        );
      }

      return {
        ok: true,
        agentId: agent.id,
        target: "send_prompt",
        runId: agent.currentRunId,
        message: `OpenClaw accepted a prompt dispatch for ${agent.name} on live session ${sessionId}.`,
      };
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        throw error;
      }

      throw new ControlPlaneError(
        500,
        `Failed to dispatch a prompt to ${agent.name}: ${describeProcessError(error)}`,
      );
    }
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

export class ClaudeCodeRuntimeActionBridge implements RuntimeActionBridge {
  constructor(private readonly options: ClaudeCodeRuntimeActionBridgeOptions) {}

  canHandle(agent: AgentDescriptor, request: AgentRuntimeActionRequest): boolean {
    return (
      getAgentSourceKind(agent) === "claude-project-logs" &&
      request.target === "send_prompt"
    );
  }

  async runAgentRuntimeAction(
    agent: AgentDescriptor,
    request: AgentRuntimeActionRequest,
  ): Promise<AgentRuntimeActionResult> {
    switch (request.target) {
      case "send_prompt":
        return await this.dispatchClaudePrompt(agent, request.message ?? "");
      default:
        throw new ControlPlaneError(
          409,
          `Claude Code does not expose ${request.target} through Agent Hub yet.`,
        );
    }
  }

  private async dispatchClaudePrompt(
    agent: AgentDescriptor,
    message: string,
  ): Promise<AgentRuntimeActionResult> {
    const sessionId = agent.sessionMetadata?.sessionId?.trim() ?? "";
    const sessionPath = agent.sessionMetadata?.sessionPath?.trim() ?? "";
    if (!sessionId) {
      throw new ControlPlaneError(
        409,
        `Claude prompt dispatch is unavailable for ${agent.name} because no local session id is visible.`,
      );
    }

    if (!sessionPath) {
      throw new ControlPlaneError(
        409,
        `Claude prompt dispatch is unavailable for ${agent.name} because no session log path is visible for truth verification.`,
      );
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new ControlPlaneError(400, "Prompt dispatch requires a non-empty message.");
    }

    const authStatus = await readClaudeAuthStatusAsync(this.options.claudeBin);
    if (authStatus === null) {
      throw new ControlPlaneError(
        409,
        `Claude prompt dispatch is unavailable for ${agent.name} because Agent Hub cannot verify a usable local Claude CLI on this machine.`,
      );
    }

    if (authStatus.loggedIn !== true) {
      throw new ControlPlaneError(
        409,
        `Claude prompt dispatch is unavailable for ${agent.name} because the local Claude CLI is not logged in. Run \`claude auth login\` first.`,
      );
    }

    const actionStartedAt = Date.now();

    try {
      await execFileAsync(
        this.options.claudeBin,
        ["-p", "--resume", sessionId, trimmedMessage],
        {
          cwd: agent.workspacePath,
          maxBuffer: 10_000_000,
        },
      );
      await waitForClaudePromptPersistence(
        sessionPath,
        trimmedMessage,
        actionStartedAt,
      );

      return {
        ok: true,
        agentId: agent.id,
        target: "send_prompt",
        runId: agent.currentRunId,
        sessionId,
        message: `Claude Code accepted a prompt dispatch for ${agent.name} on local session ${sessionId}.`,
      };
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        throw error;
      }

      const details = describeProcessError(error);
      if (details.includes("No conversation found with session ID")) {
        throw new ControlPlaneError(
          409,
          `Claude prompt dispatch is unavailable for ${agent.name} because the local Claude CLI could not resume session ${sessionId}.`,
        );
      }

      if (details.includes("Not logged in")) {
        throw new ControlPlaneError(
          409,
          `Claude prompt dispatch is unavailable for ${agent.name} because the local Claude CLI is not logged in. Run \`claude auth login\` first.`,
        );
      }

      throw new ControlPlaneError(
        500,
        `Failed to dispatch a prompt to ${agent.name} through Claude Code: ${details}`,
      );
    }
  }
}

export class GeminiCliRuntimeActionBridge implements RuntimeActionBridge {
  constructor(private readonly options: GeminiCliRuntimeActionBridgeOptions) {}

  canHandle(agent: AgentDescriptor, request: AgentRuntimeActionRequest): boolean {
    return (
      getAgentSourceKind(agent) === "gemini-project-chats" &&
      request.target === "send_prompt"
    );
  }

  async runAgentRuntimeAction(
    agent: AgentDescriptor,
    request: AgentRuntimeActionRequest,
  ): Promise<AgentRuntimeActionResult> {
    switch (request.target) {
      case "send_prompt":
        return await this.dispatchGeminiPrompt(agent, request.message ?? "");
      default:
        throw new ControlPlaneError(
          409,
          `Gemini CLI does not expose ${request.target} through Agent Hub yet.`,
        );
    }
  }

  private async dispatchGeminiPrompt(
    agent: AgentDescriptor,
    message: string,
  ): Promise<AgentRuntimeActionResult> {
    const sessionId = agent.sessionMetadata?.sessionId?.trim() ?? "";
    const sessionPath = agent.sessionMetadata?.sessionPath?.trim() ?? "";
    if (!sessionId) {
      throw new ControlPlaneError(
        409,
        `Gemini prompt dispatch is unavailable for ${agent.name} because no local session id is visible.`,
      );
    }

    if (!sessionPath) {
      throw new ControlPlaneError(
        409,
        `Gemini prompt dispatch is unavailable for ${agent.name} because no session file is visible for truth verification.`,
      );
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new ControlPlaneError(400, "Prompt dispatch requires a non-empty message.");
    }

    const controlState = getGeminiControlState(this.options.geminiDir);
    if (controlState === "auth_required") {
      throw new ControlPlaneError(
        409,
        `Gemini prompt dispatch is unavailable for ${agent.name} because the local Gemini CLI auth method is not configured. Configure Gemini auth first.`,
      );
    }

    if (controlState === "unavailable") {
      throw new ControlPlaneError(
        409,
        `Gemini prompt dispatch is unavailable for ${agent.name} because Agent Hub cannot verify a usable local Gemini CLI auth posture on this machine.`,
      );
    }

    const baselineMatchCount = countGeminiUserPromptMatches(sessionPath, trimmedMessage);

    try {
      await execFileAsync(
        this.options.geminiBin,
        ["-p", trimmedMessage, "--resume", sessionId],
        {
          cwd: agent.workspacePath,
          maxBuffer: 10_000_000,
        },
      );
      await waitForGeminiPromptPersistence(
        sessionPath,
        trimmedMessage,
        baselineMatchCount,
      );

      return {
        ok: true,
        agentId: agent.id,
        target: "send_prompt",
        runId: agent.currentRunId,
        sessionId,
        message: `Gemini CLI accepted a prompt dispatch for ${agent.name} on local session ${sessionId}.`,
      };
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        throw error;
      }

      const details = describeProcessError(error);
      if (details.includes("Please set an Auth method")) {
        throw new ControlPlaneError(
          409,
          `Gemini prompt dispatch is unavailable for ${agent.name} because the local Gemini CLI auth method is not configured. Configure Gemini auth first.`,
        );
      }

      if (
        details.includes("No previous sessions found for this project") ||
        details.includes("Invalid session identifier") ||
        details.includes("Error resuming session")
      ) {
        throw new ControlPlaneError(
          409,
          `Gemini prompt dispatch is unavailable for ${agent.name} because the local Gemini CLI could not resume session ${sessionId}.`,
        );
      }

      throw new ControlPlaneError(
        500,
        `Failed to dispatch a prompt to ${agent.name} through Gemini CLI: ${details}`,
      );
    }
  }
}

export class CopilotSessionRuntimeActionBridge
  implements RuntimeActionBridge
{
  constructor(
    private readonly options: CopilotSessionRuntimeActionBridgeOptions,
  ) {}

  canHandle(agent: AgentDescriptor, request: AgentRuntimeActionRequest): boolean {
    return (
      getAgentSourceKind(agent) === "copilot-session-state" &&
      request.target === "send_prompt"
    );
  }

  async runAgentRuntimeAction(
    agent: AgentDescriptor,
    request: AgentRuntimeActionRequest,
  ): Promise<AgentRuntimeActionResult> {
    switch (request.target) {
      case "send_prompt":
        return await this.dispatchCopilotPrompt(agent, request.message ?? "");
      default:
        throw new ControlPlaneError(
          409,
          `Copilot does not expose ${request.target} through Agent Hub yet.`,
        );
    }
  }

  private async dispatchCopilotPrompt(
    agent: AgentDescriptor,
    message: string,
  ): Promise<AgentRuntimeActionResult> {
    const sessionId = agent.sessionMetadata?.sessionId?.trim() ?? "";
    const sessionPath = agent.sessionMetadata?.sessionPath?.trim() ?? "";
    if (!sessionId) {
      throw new ControlPlaneError(
        409,
        `Copilot prompt dispatch is unavailable for ${agent.name} because no local session id is visible.`,
      );
    }

    if (!sessionPath) {
      throw new ControlPlaneError(
        409,
        `Copilot prompt dispatch is unavailable for ${agent.name} because no session path is visible for truth verification.`,
      );
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new ControlPlaneError(400, "Prompt dispatch requires a non-empty message.");
    }

    let client: CopilotSdkClient | null = null;
    let session: CopilotSdkSession | null = null;

    try {
      const sdk = await loadCopilotSdkModule(this.options.copilotSdkModulePath);
      client = new sdk.CopilotClient({
        cliPath: this.options.copilotBin,
        cwd: agent.workspacePath,
      });
      await client.start();
      session = await client.resumeSession(sessionId, {
        onPermissionRequest: sdk.approveAll,
        suppressResumeEvent: true,
        workingDirectory: agent.workspacePath,
      });
      const actionStartedAt = Date.now();
      await session.send({
        prompt: trimmedMessage,
      });
      await waitForCopilotPromptPersistence(
        sessionPath,
        trimmedMessage,
        actionStartedAt,
      );

      return {
        ok: true,
        agentId: agent.id,
        target: "send_prompt",
        runId: agent.currentRunId,
        sessionId,
        message: `Copilot accepted a prompt dispatch for ${agent.name} on local session ${sessionId}.`,
      };
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        throw error;
      }

      throw new ControlPlaneError(
        500,
        `Failed to dispatch a prompt to ${agent.name} through the Copilot SDK: ${describeProcessError(error)}`,
      );
    } finally {
      if (session) {
        try {
          await session.disconnect();
        } catch {
          // Ignore cleanup failures and preserve the original action result.
        }
      }

      if (client) {
        try {
          await client.stop();
        } catch {
          // Ignore cleanup failures and preserve the original action result.
        }
      }
    }
  }
}

function parseOpenClawDaemonAction(
  stdout: string,
): OpenClawDaemonActionResponse {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ControlPlaneError(
      500,
      "OpenClaw gateway recovery returned no JSON output.",
    );
  }

  try {
    return JSON.parse(trimmed) as OpenClawDaemonActionResponse;
  } catch {
    throw new ControlPlaneError(
      500,
      "OpenClaw gateway recovery returned invalid JSON output.",
    );
  }
}

function parseOpenClawPromptDispatch(
  stdout: string,
): OpenClawPromptDispatchResponse {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ControlPlaneError(
      500,
      "OpenClaw prompt dispatch returned no JSON output.",
    );
  }

  try {
    return JSON.parse(trimmed) as OpenClawPromptDispatchResponse;
  } catch {
    throw new ControlPlaneError(
      500,
      "OpenClaw prompt dispatch returned invalid JSON output.",
    );
  }
}

function isOpenClawPromptDispatchSuccess(
  payload: OpenClawPromptDispatchResponse,
): boolean {
  return payload.ok === true || payload.status === "ok";
}

function parseOpenClawSessionReset(
  stdout: string,
): OpenClawSessionResetResponse {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ControlPlaneError(
      500,
      "OpenClaw session reset returned no JSON output.",
    );
  }

  try {
    return JSON.parse(trimmed) as OpenClawSessionResetResponse;
  } catch {
    throw new ControlPlaneError(
      500,
      "OpenClaw session reset returned invalid JSON output.",
    );
  }
}

function describeUnsupportedRuntimeAction(
  agent: AgentDescriptor,
  code: AgentRuntimeActionSupportCode,
): string {
  switch (code) {
    case "openclaw-session-unavailable":
      return `OpenClaw session reset is unavailable for ${agent.name} because Agent Hub cannot currently prove a live session key and healthy gateway bridge.`;
    case "openclaw-session-reset":
      return `OpenClaw session reset is already available for ${agent.name}.`;
    case "openclaw-prompt-dispatch":
      return `Live prompt dispatch is already available for ${agent.name}.`;
    case "openclaw-gateway-healthy":
      return `OpenClaw gateway recovery is not needed for ${agent.name} because its gateway is already reachable.`;
    case "openclaw-prompt-unavailable":
      return `OpenClaw prompt dispatch is unavailable for ${agent.name} because Agent Hub cannot currently prove a reachable gateway and live session id.`;
    case "claude-prompt-dispatch":
      return `Live Claude Code prompt dispatch is already available for ${agent.name}.`;
    case "claude-prompt-unavailable":
      return `Claude prompt dispatch is unavailable for ${agent.name} because Agent Hub cannot currently prove a resumable local session log and working Claude CLI.`;
    case "claude-auth-required":
      return `Claude prompt dispatch is unavailable for ${agent.name} because the local Claude CLI is not logged in. Run \`claude auth login\` first.`;
    case "gemini-prompt-dispatch":
      return `Live Gemini CLI prompt dispatch is already available for ${agent.name}.`;
    case "gemini-prompt-unavailable":
      return `Gemini prompt dispatch is unavailable for ${agent.name} because Agent Hub cannot currently prove a resumable local Gemini session and usable Gemini CLI auth posture.`;
    case "gemini-auth-required":
      return `Gemini prompt dispatch is unavailable for ${agent.name} because the local Gemini CLI auth method is not configured yet. Configure Gemini auth first.`;
    case "sidecar-prompt-dispatch":
      return `Live prompt dispatch is already available for ${agent.name} through its declared loopback sidecar bridge.`;
    case "sidecar-prompt-unavailable":
      return `Prompt dispatch is unavailable for ${agent.name} because Agent Hub cannot currently prove a local loopback sidecar bridge for it.`;
    case "copilot-prompt-dispatch":
      return `Live Copilot prompt dispatch is already available for ${agent.name}.`;
    case "copilot-prompt-unavailable":
      return `Copilot prompt dispatch is unavailable for ${agent.name} because Agent Hub cannot currently prove a local session id.`;
    case "unsupported-runtime":
      return `Agent ${agent.id} does not expose a truthful runtime control bridge yet.`;
    case "agent-missing":
    default:
      return `Runtime control is unavailable because agent metadata is missing.`;
  }
}

function deriveOpenClawRuntimeAgentId(agent: AgentDescriptor): string {
  if (!agent.id.startsWith(OPENCLAW_AGENT_PREFIX)) {
    throw new ControlPlaneError(
      409,
      `Agent ${agent.id} is not a truthful OpenClaw runtime session.`,
    );
  }

  return agent.id.slice(OPENCLAW_AGENT_PREFIX.length);
}

async function readClaudeAuthStatusAsync(
  claudeBin: string,
): Promise<ClaudeAuthStatusResponse | null> {
  try {
    const { stdout } = await execFileAsync(claudeBin, ["auth", "status"], {
      encoding: "utf8",
      maxBuffer: 1_000_000,
    });
    return parseClaudeAuthStatus(stdout);
  } catch (error) {
    return parseClaudeAuthStatus(readProcessOutput(error, "stdout"));
  }
}

async function loadCopilotSdkModule(
  modulePath: string,
): Promise<CopilotSdkModule> {
  const specifier = modulePath.includes("://")
    ? modulePath
    : pathToFileURL(modulePath).href;

  let moduleRecord: unknown;
  try {
    moduleRecord = await import(specifier);
  } catch (error) {
    throw new ControlPlaneError(
      500,
      `Failed to load the Copilot SDK from ${modulePath}: ${describeProcessError(error)}`,
    );
  }

  if (
    !moduleRecord ||
    typeof moduleRecord !== "object" ||
    !("CopilotClient" in moduleRecord) ||
    typeof moduleRecord.CopilotClient !== "function" ||
    !("approveAll" in moduleRecord)
  ) {
    throw new ControlPlaneError(
      500,
      `The Copilot SDK module at ${modulePath} does not expose the expected client API.`,
    );
  }

  return moduleRecord as CopilotSdkModule;
}

function countGeminiUserPromptMatches(sessionPath: string, prompt: string): number {
  const parsed = readGeminiSessionFile(sessionPath);

  if (!parsed) {
    return 0;
  }

  return parsed.messages.filter(
    (message) => message.role === "user" && message.text === prompt,
  ).length;
}

async function waitForGeminiPromptPersistence(
  sessionPath: string,
  prompt: string,
  baselineMatchCount: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const matchCount = countGeminiUserPromptMatches(sessionPath, prompt);

      if (matchCount > baselineMatchCount) {
        return;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    await wait(500);
  }

  throw new ControlPlaneError(
    500,
    `Gemini CLI did not persist the prompt dispatch within ${timeoutMs}ms.`,
  );
}

async function waitForCopilotPromptPersistence(
  sessionPath: string,
  prompt: string,
  notBeforeMs: number,
  timeoutMs = 15_000,
): Promise<void> {
  const eventsPath = path.join(sessionPath, "events.jsonl");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const content = await readFile(eventsPath, "utf8");
      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-200);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const record = parseCopilotSessionEvent(lines[index]);
        if (!record) {
          continue;
        }

        if (record.type !== "user.message" || record.data?.content !== prompt) {
          continue;
        }

        const eventTime = Date.parse(record.timestamp ?? "");
        if (!Number.isFinite(eventTime) || eventTime < notBeforeMs) {
          continue;
        }

        return;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    await wait(500);
  }

  throw new ControlPlaneError(
    500,
    `Copilot did not persist the prompt dispatch within ${timeoutMs}ms.`,
  );
}

async function waitForClaudePromptPersistence(
  sessionPath: string,
  prompt: string,
  notBeforeMs: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const content = await readFile(sessionPath, "utf8");
      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-200);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const record = parseClaudeSessionEvent(lines[index]);
        if (!record) {
          continue;
        }

        if (
          record.type !== "queue-operation" ||
          record.operation !== "enqueue" ||
          record.content !== prompt
        ) {
          continue;
        }

        const eventTime = Date.parse(record.timestamp ?? "");
        if (!Number.isFinite(eventTime) || eventTime < notBeforeMs) {
          continue;
        }

        return;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    await wait(500);
  }

  throw new ControlPlaneError(
    500,
    `Claude Code did not persist the prompt dispatch within ${timeoutMs}ms.`,
  );
}

function parseClaudeAuthStatus(
  output: string | null,
): ClaudeAuthStatusResponse | null {
  if (!output) {
    return null;
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "loggedIn" in parsed &&
      typeof parsed.loggedIn === "boolean"
    ) {
      return parsed as ClaudeAuthStatusResponse;
    }
  } catch {
    return null;
  }

  return null;
}

function parseCopilotSessionEvent(line: string): CopilotSessionEventRecord | null {
  try {
    return JSON.parse(line) as CopilotSessionEventRecord;
  } catch {
    return null;
  }
}

function parseClaudeSessionEvent(line: string): ClaudeSessionEventRecord | null {
  try {
    return JSON.parse(line) as ClaudeSessionEventRecord;
  } catch {
    return null;
  }
}

function parseSidecarRuntimeActionResponse(
  text: string,
): SidecarRuntimeActionResponse {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ControlPlaneError(
      500,
      "The declared loopback sidecar bridge returned no JSON acknowledgement.",
    );
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as SidecarRuntimeActionResponse;
    }
  } catch {
    throw new ControlPlaneError(
      500,
      "The declared loopback sidecar bridge returned invalid JSON acknowledgement.",
    );
  }

  throw new ControlPlaneError(
    500,
    "The declared loopback sidecar bridge returned an unusable acknowledgement payload.",
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function describeProcessError(error: unknown): string {
  if (error instanceof Error) {
    const stdout = readProcessOutput(error, "stdout");
    const stderr = readProcessOutput(error, "stderr");
    const details = [error.message, stderr, stdout].filter(Boolean);
    return details.join(" | ");
  }

  return String(error);
}

function readProcessOutput(
  error: unknown,
  key: "stdout" | "stderr",
): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const value = Reflect.get(error, key);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Buffer.isBuffer(value)) {
    const trimmed = value.toString("utf8").trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}
