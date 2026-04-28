import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

import type { ControlPlaneService } from "./control-plane-service.js";
import type { HubNotifier } from "./notifier.js";

const COPILOT_AGENT_PREFIX = "copilot-session-";
const COPILOT_RUN_PREFIX = "copilot-run-";

interface CopilotSessionRuntimeOptions {
  enabled: boolean;
  logger: FastifyBaseLogger;
  notifier: HubNotifier;
  pollIntervalMs: number;
  service: ControlPlaneService;
  sessionStateDir: string;
}

interface SessionWorkspaceMetadata {
  branch?: string;
  created_at?: string;
  cwd?: string;
  git_root?: string;
  name?: string;
  summary?: string;
  summary_count?: string;
  updated_at?: string;
}

interface SessionStartMetadata {
  alreadyInUse?: boolean;
  copilotVersion?: string;
  cwd?: string;
  remoteSteerable?: boolean;
  startTime?: string;
}

interface DiscoveredCopilotSession {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  displayName: string;
  summary: string | null;
  summaryCount: number | null;
  createdAt: string;
  updatedAt: string;
  gitRoot: string | null;
  branch: string | null;
  toolVersion: string | null;
  remoteSteerable: boolean | null;
  alreadyInUse: boolean | null;
}

export class CopilotSessionRuntimeService {
  private interval: NodeJS.Timeout | null = null;
  private lastFingerprint: string | null = null;

  constructor(private readonly options: CopilotSessionRuntimeOptions) {}

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

  private sync(): void {
    try {
      const sessions = discoverCopilotSessions(this.options.sessionStateDir);
      const fingerprint = JSON.stringify(
        sessions.map((session) => [
          session.sessionId,
          session.sessionPath,
          session.cwd,
          session.displayName,
          session.summary,
          session.summaryCount,
          session.createdAt,
          session.updatedAt,
          session.gitRoot,
          session.branch,
          session.toolVersion,
          session.remoteSteerable,
          session.alreadyInUse,
        ]),
      );

      if (fingerprint === this.lastFingerprint) {
        return;
      }

      this.lastFingerprint = fingerprint;

      const knownCopilotAgents = this.options.service
        .listAgents()
        .filter((agent) => agent.id.startsWith(COPILOT_AGENT_PREFIX));
      const activeIds = new Set(sessions.map((session) => session.sessionId));

      for (const session of sessions) {
        const agentId = `${COPILOT_AGENT_PREFIX}${session.sessionId}`;
        const runId = `${COPILOT_RUN_PREFIX}${session.sessionId}`;
        const existingAgent = knownCopilotAgents.find((agent) => agent.id === agentId);

        const result = this.options.service.ingestUpdate({
          agent: {
            id: agentId,
            name: `Copilot · ${session.displayName}`,
            platform: "copilot-cli",
            workspacePath: session.cwd,
            state: "running",
            health: "healthy",
            attention: "silent",
            currentRunId: runId,
            lastHeartbeatAt: session.updatedAt,
            lastEventAt: session.updatedAt,
            sessionMetadata: {
              sessionId: session.sessionId,
              sessionPath: session.sessionPath,
              gitRoot: session.gitRoot,
              branch: session.branch,
              summary: session.summary,
              summaryCount: session.summaryCount,
              startedAt: session.createdAt,
              updatedAt: session.updatedAt,
              toolVersion: session.toolVersion,
              remoteSteerable: session.remoteSteerable,
              alreadyInUse: session.alreadyInUse,
            },
          },
          run: {
            id: runId,
            title: `Copilot session · ${session.displayName}`,
            state: "running",
            health: "healthy",
            attention: "silent",
            progress: {
              phase: "active session",
              percent: null,
              message: buildCopilotProgressMessage(session),
            },
            lastEventAt: session.updatedAt,
            createdAt: session.createdAt,
          },
          event: existingAgent
            ? existingAgent.state === "offline"
              ? {
                  type: "agent.recovered",
                  attention: "info",
                  message: `Copilot session “${session.displayName}” is active again.`,
                  createdAt: session.updatedAt,
                }
              : undefined
            : {
                type: "session.opened",
                attention: "info",
                message: `Discovered live Copilot session “${session.displayName}”.`,
                createdAt: session.updatedAt,
              },
        });

        if (result.event) {
          this.options.notifier.publish({
            type: "event",
            data: result.event,
          });
        }
      }

      for (const agent of knownCopilotAgents) {
        const sessionId = agent.id.slice(COPILOT_AGENT_PREFIX.length);

        if (activeIds.has(sessionId)) {
          continue;
        }

        const runId = `${COPILOT_RUN_PREFIX}${sessionId}`;
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
    } catch (error) {
      this.options.logger.warn(
        {
          error,
        },
        "Failed to synchronize Copilot sessions",
      );
    }
  }
}

function discoverCopilotSessions(sessionStateDir: string): DiscoveredCopilotSession[] {
  let entries: string[] = [];

  try {
    entries = readdirSync(sessionStateDir);
  } catch {
    return [];
  }

  const sessions: DiscoveredCopilotSession[] = [];

  for (const entry of entries) {
    const sessionDir = path.join(sessionStateDir, entry);

    let stats;
    try {
      stats = statSync(sessionDir);
    } catch {
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    let files: string[] = [];
    try {
      files = readdirSync(sessionDir);
    } catch {
      continue;
    }

    const activeLockPids = files
      .map((file) => parseLockPid(file))
      .filter((pid): pid is number => pid !== null && isPidAlive(pid));

    if (activeLockPids.length === 0) {
      continue;
    }

    const metadata = readWorkspaceMetadata(path.join(sessionDir, "workspace.yaml"));
    const startMetadata = readSessionStartMetadata(
      path.join(sessionDir, "events.jsonl"),
    );
    const cwd = metadata.cwd ?? metadata.git_root ?? startMetadata.cwd ?? sessionDir;
    const displayName = buildDisplayName(metadata, cwd, entry);
    const updatedAt = metadata.updated_at ?? stats.mtime.toISOString();
    const createdAt =
      startMetadata.startTime ??
      metadata.created_at ??
      stats.birthtime.toISOString();

    sessions.push({
      sessionId: entry,
      sessionPath: sessionDir,
      cwd,
      displayName,
      summary: normalizeText(metadata.summary),
      summaryCount: parseOptionalInteger(metadata.summary_count),
      createdAt,
      updatedAt,
      gitRoot: metadata.git_root ?? null,
      branch: metadata.branch ?? null,
      toolVersion: startMetadata.copilotVersion ?? null,
      remoteSteerable:
        typeof startMetadata.remoteSteerable === "boolean"
          ? startMetadata.remoteSteerable
          : null,
      alreadyInUse:
        typeof startMetadata.alreadyInUse === "boolean"
          ? startMetadata.alreadyInUse
          : null,
    });
  }

  return sessions.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

function parseLockPid(fileName: string): number | null {
  const match = /^inuse\.(\d+)\.lock$/.exec(fileName);

  if (!match) {
    return null;
  }

  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) ? pid : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readWorkspaceMetadata(filePath: string): SessionWorkspaceMetadata {
  try {
    const content = readFileSync(filePath, "utf8");
    return parseTopLevelYaml(content);
  } catch {
    return {};
  }
}

function readSessionStartMetadata(filePath: string): SessionStartMetadata {
  try {
    const content = readFileSync(filePath, "utf8");

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();

      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("type" in parsed) ||
        parsed.type !== "session.start" ||
        !("data" in parsed) ||
        typeof parsed.data !== "object" ||
        parsed.data === null
      ) {
        continue;
      }

      const data = parsed.data as Record<string, unknown>;
      const context =
        typeof data.context === "object" && data.context !== null
          ? (data.context as Record<string, unknown>)
          : null;

      return {
        copilotVersion:
          typeof data.copilotVersion === "string"
            ? data.copilotVersion
            : undefined,
        startTime:
          typeof data.startTime === "string" ? data.startTime : undefined,
        remoteSteerable:
          typeof data.remoteSteerable === "boolean"
            ? data.remoteSteerable
            : undefined,
        alreadyInUse:
          typeof data.alreadyInUse === "boolean"
            ? data.alreadyInUse
            : undefined,
        cwd:
          context && typeof context.cwd === "string"
            ? context.cwd
            : undefined,
      };
    }
  } catch {
    return {};
  }

  return {};
}

function parseTopLevelYaml(content: string): SessionWorkspaceMetadata {
  const parsed: SessionWorkspaceMetadata = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    switch (key) {
      case "created_at":
      case "cwd":
      case "git_root":
      case "branch":
      case "name":
      case "summary":
      case "summary_count":
      case "updated_at":
        parsed[key] = value;
        break;
      default:
        break;
    }
  }

  return parsed;
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}

function truncateDisplayName(value: string, maxLength = 56): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildDisplayName(
  metadata: SessionWorkspaceMetadata,
  cwd: string,
  sessionId: string,
): string {
  const preferredName = normalizeText(metadata.name);
  if (preferredName) {
    return preferredName;
  }

  const summary = normalizeText(metadata.summary);
  if (summary) {
    return truncateDisplayName(summary);
  }

  const workspaceName = path.basename(cwd);
  return workspaceName || sessionId.slice(0, 8);
}

function buildCopilotProgressMessage(
  session: Pick<DiscoveredCopilotSession, "cwd" | "branch">,
): string {
  return session.branch
    ? `Live Copilot CLI session discovered from ${session.cwd} on branch ${session.branch}.`
    : `Live Copilot CLI session discovered from ${session.cwd}.`;
}
