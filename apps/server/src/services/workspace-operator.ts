import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentDescriptor,
  AgentWorkspaceActionResult,
  AgentWorkspaceActionTarget,
} from "../shared-types.js";
import {
  getAgentSourceKind,
  hasAgentWorkspaceActionSupport,
} from "../shared-types.js";
import { ControlPlaneError } from "./control-plane-service.js";

const execFileAsync = promisify(execFile);
const COPILOT_AGENT_PREFIX = "copilot-session-";

interface WorkspaceOperatorServiceOptions {
  claudeProjectsDir: string;
  copilotSessionStateDir: string;
  geminiStateDir: string;
  openClawStateDir: string;
}

export class WorkspaceOperatorService {
  constructor(private readonly options: WorkspaceOperatorServiceOptions) {}

  async runAgentWorkspaceAction(
    agent: AgentDescriptor,
    target: AgentWorkspaceActionTarget,
  ): Promise<AgentWorkspaceActionResult> {
    const openedPath = await this.resolveTargetPath(agent, target);

    await execFileAsync("open", buildOpenArguments(target, openedPath));

    return {
      ok: true,
      agentId: agent.id,
      target,
      openedPath,
      message: buildSuccessMessage(target, agent.name, openedPath),
    };
  }

  private async resolveTargetPath(
    agent: AgentDescriptor,
    target: AgentWorkspaceActionTarget,
  ): Promise<string> {
    let targetPath = agent.workspacePath;
    if (target === "session_state") {
      targetPath = this.resolveSessionStatePath(agent);
    } else if (target === "runtime_home") {
      targetPath = this.resolveRuntimeHomePath(agent);
    }

    await this.ensurePathExists(targetPath);
    return targetPath;
  }

  private resolveSessionStatePath(agent: AgentDescriptor): string {
    const explicitSessionPath = agent.sessionMetadata?.sessionPath?.trim() ?? "";
    if (hasAgentWorkspaceActionSupport(agent, "session_state") && explicitSessionPath) {
      return explicitSessionPath;
    }

    if (getAgentSourceKind(agent) !== "copilot-session-state") {
      throw new ControlPlaneError(
        409,
        `Agent ${agent.id} does not expose a local session path.`,
      );
    }

    const sessionId = agent.id.startsWith(COPILOT_AGENT_PREFIX)
      ? agent.id.slice(COPILOT_AGENT_PREFIX.length)
      : agent.sessionMetadata?.sessionId?.trim() ?? "";
    if (!sessionId) {
      throw new ControlPlaneError(
        409,
        `Agent ${agent.id} does not contain a valid Copilot session id or session path.`,
      );
    }

    return path.join(this.options.copilotSessionStateDir, sessionId);
  }

  private resolveRuntimeHomePath(agent: AgentDescriptor): string {
    if (!hasAgentWorkspaceActionSupport(agent, "runtime_home")) {
      throw new ControlPlaneError(
        409,
        `Agent ${agent.id} does not expose a supported local runtime directory.`,
      );
    }

    switch (agent.platform) {
      case "claude-code":
        return resolveRuntimeHome(this.options.claudeProjectsDir, "projects");
      case "copilot-cli":
        return resolveRuntimeHome(this.options.copilotSessionStateDir, "session-state");
      case "gemini-cli":
        return this.options.geminiStateDir;
      case "openclaw":
        return this.options.openClawStateDir;
      default:
        throw new ControlPlaneError(
          409,
          `Agent ${agent.id} does not expose a supported local runtime directory.`,
        );
    }
  }

  private async ensurePathExists(targetPath: string): Promise<void> {
    const result = await stat(targetPath).catch(() => null);

    if (!result) {
      throw new ControlPlaneError(404, `Path ${targetPath} was not found.`);
    }
  }
}

function buildOpenArguments(
  target: AgentWorkspaceActionTarget,
  targetPath: string,
): string[] {
  switch (target) {
    case "terminal":
      return ["-a", "Terminal", targetPath];
    case "finder":
    case "runtime_home":
    case "session_state":
    default:
      return [targetPath];
  }
}

function buildSuccessMessage(
  target: AgentWorkspaceActionTarget,
  agentName: string,
  targetPath: string,
): string {
  switch (target) {
    case "terminal":
      return `Opened ${agentName} in Terminal at ${targetPath}.`;
    case "runtime_home":
      return `Opened the local runtime files for ${agentName}.`;
    case "session_state":
      return `Opened the local session path for ${agentName}.`;
    case "finder":
    default:
      return `Opened ${agentName} in Finder at ${targetPath}.`;
  }
}

function resolveRuntimeHome(configuredPath: string, nestedDirName: string): string {
  return path.basename(configuredPath) === nestedDirName
    ? path.dirname(configuredPath)
    : configuredPath;
}
