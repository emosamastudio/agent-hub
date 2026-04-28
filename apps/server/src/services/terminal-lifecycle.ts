import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  getSessionTerminalAttachSupport,
  type AgentDescriptor,
  type SessionActionResult,
  type SessionDescriptor,
} from "../shared-types.js";
import { ControlPlaneError } from "./control-plane-service.js";

const execFileAsync = promisify(execFile);

interface TerminalLifecycleServiceOptions {
  claudeBin: string;
  geminiBin: string;
}

export class TerminalLifecycleService {
  constructor(private readonly options: TerminalLifecycleServiceOptions) {}

  async attachToSession(
    agent: AgentDescriptor,
    session: SessionDescriptor,
  ): Promise<SessionActionResult> {
    const support = getSessionTerminalAttachSupport(agent, session);
    if (!support.supported) {
      throw new ControlPlaneError(
        409,
        describeUnsupportedAttach(agent.name, support.code),
      );
    }

    const runtimeSessionId =
      session.sessionId?.trim() ?? agent.sessionMetadata?.sessionId?.trim() ?? "";
    if (!runtimeSessionId) {
      throw new ControlPlaneError(
        409,
        `Terminal attach is unavailable for ${agent.name} because no live session id is visible.`,
      );
    }

    const launchCommand = buildLaunchCommand(
      agent,
      runtimeSessionId,
      this.options,
    );

    try {
      await execFileAsync("osascript", [
        "-e",
        buildTerminalAttachAppleScript(launchCommand),
      ]);
    } catch (error) {
      throw new ControlPlaneError(
        500,
        `Failed to open a Terminal attach flow for ${agent.name}: ${describeProcessError(error)}`,
      );
    }

    return {
      ok: true,
      sessionId: session.id,
      agentId: agent.id,
      target: "attach_terminal",
      runId: agent.currentRunId,
      openedPath: agent.workspacePath,
      launchCommand,
      message: `Opened a local Terminal attach flow for ${agent.name} on session ${runtimeSessionId}.`,
    };
  }
}

function buildLaunchCommand(
  agent: AgentDescriptor,
  runtimeSessionId: string,
  options: TerminalLifecycleServiceOptions,
): string {
  const workspacePath = quoteForShell(agent.workspacePath);
  const header = `cd ${workspacePath} && clear && printf '%s\\n' ${quoteForShell(
    `Agent Hub attached to ${agent.name} (${runtimeSessionId}).`,
  )}`;

  switch (agent.platform) {
    case "claude-code":
      return `${header} && exec ${quoteForShell(options.claudeBin)} --resume ${quoteForShell(runtimeSessionId)}`;
    case "gemini-cli":
      return `${header} && exec ${quoteForShell(options.geminiBin)} --resume ${quoteForShell(runtimeSessionId)}`;
    default:
      throw new ControlPlaneError(
        409,
        `Terminal attach is not exposed for ${agent.name} yet.`,
      );
  }
}

function buildTerminalAttachAppleScript(command: string): string {
  return `tell application "Terminal"
activate
do script ${toAppleScriptString(command)}
end tell`;
}

function describeUnsupportedAttach(
  agentName: string,
  code:
    | "session-missing"
    | "session-id-missing"
    | "claude-resume-terminal"
    | "gemini-resume-terminal"
    | "session-attach-unsupported-runtime",
): string {
  switch (code) {
    case "session-missing":
      return `Terminal attach is unavailable for ${agentName} because the selected session is no longer visible.`;
    case "session-id-missing":
      return `Terminal attach is unavailable for ${agentName} because no live session id is visible yet.`;
    case "claude-resume-terminal":
    case "gemini-resume-terminal":
      return `Terminal attach is already available for ${agentName}.`;
    case "session-attach-unsupported-runtime":
      return `Terminal attach is currently exposed only for Claude Code and Gemini CLI sessions.`;
  }
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function describeProcessError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
