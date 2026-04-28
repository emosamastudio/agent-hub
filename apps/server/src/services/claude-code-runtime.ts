import { execFileSync } from "node:child_process";
import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

import type { ControlPlaneService } from "./control-plane-service.js";
import type { HubNotifier } from "./notifier.js";

const CLAUDE_AGENT_PREFIX = "claude-session-";
const CLAUDE_RUN_PREFIX = "claude-run-";
const PREVIEW_BYTES = 8_192;

interface ClaudeCodeRuntimeOptions {
  claudeBin: string;
  enabled: boolean;
  logger: FastifyBaseLogger;
  notifier: HubNotifier;
  pollIntervalMs: number;
  projectsDir: string;
  service: ControlPlaneService;
}

type ClaudeControlState = "ready" | "auth_required" | "unavailable";

interface DiscoveredClaudeSession {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  displayName: string;
  updatedAt: string;
  permissionMode: string | null;
  gitBranch: string | null;
  version: string | null;
}

interface DiscoveredClaudeSessionCandidate extends DiscoveredClaudeSession {
  filePath: string;
  mtimeMs: number;
}

interface ActiveClaudeProcess {
  pid: number;
  cwd: string | null;
  sessionFiles: string[];
}

export class ClaudeCodeRuntimeService {
  private interval: NodeJS.Timeout | null = null;
  private lastFingerprint: string | null = null;

  constructor(private readonly options: ClaudeCodeRuntimeOptions) {}

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
      const sessions = discoverClaudeSessions(this.options.projectsDir);
      const controlState = getClaudeControlState(this.options.claudeBin);
      const fingerprint = JSON.stringify(
        sessions.map((session) => [
          session.sessionId,
          session.sessionPath,
          session.cwd,
          session.displayName,
          session.updatedAt,
          session.permissionMode,
          session.gitBranch,
          session.version,
          controlState,
        ]),
      );

      if (fingerprint === this.lastFingerprint) {
        return;
      }

      this.lastFingerprint = fingerprint;

      const knownClaudeAgents = this.options.service
        .listAgents()
        .filter((agent) => agent.id.startsWith(CLAUDE_AGENT_PREFIX));
      const activeIds = new Set(sessions.map((session) => session.sessionId));

      for (const session of sessions) {
        const agentId = `${CLAUDE_AGENT_PREFIX}${session.sessionId}`;
        const runId = `${CLAUDE_RUN_PREFIX}${session.sessionId}`;
        const existingAgent = knownClaudeAgents.find((agent) => agent.id === agentId);
        const result = this.options.service.ingestUpdate({
          agent: {
            id: agentId,
            name: `Claude Code · ${session.displayName}`,
            platform: "claude-code",
            workspacePath: session.cwd,
            state: "running",
            health: describeClaudeAgentHealth(controlState),
            attention: describeClaudeAgentAttention(controlState),
            currentRunId: runId,
            lastHeartbeatAt: session.updatedAt,
            lastEventAt: session.updatedAt,
            sessionMetadata: {
              sessionId: session.sessionId,
              sessionPath: session.sessionPath,
              branch: session.gitBranch,
              updatedAt: session.updatedAt,
              toolVersion: session.version,
            },
          },
          run: {
            id: runId,
            title: `Claude Code session · ${session.displayName}`,
            state: "running",
            health: describeClaudeAgentHealth(controlState),
            attention: describeClaudeAgentAttention(controlState),
            progress: {
              phase: describeClaudePhase(session.permissionMode, controlState),
              percent: null,
              message: buildLiveClaudeMessage(session, controlState),
            },
            lastEventAt: session.updatedAt,
          },
          event: existingAgent
            ? existingAgent.state === "offline"
              ? {
                  type: "agent.recovered",
                  attention: "info",
                  message: `Claude Code session “${session.displayName}” is active again.`,
                  createdAt: session.updatedAt,
                }
              : undefined
            : {
                type: "session.opened",
                attention: "info",
                message: `Discovered live Claude Code session “${session.displayName}”.`,
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

      for (const agent of knownClaudeAgents) {
        const sessionId = agent.id.slice(CLAUDE_AGENT_PREFIX.length);

        if (activeIds.has(sessionId)) {
          continue;
        }

        const runId = `${CLAUDE_RUN_PREFIX}${sessionId}`;
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
        "Failed to synchronize Claude Code sessions",
      );
    }
  }
}

function discoverClaudeSessions(projectsDir: string): DiscoveredClaudeSession[] {
  const activeProcesses = listActiveClaudeProcesses(projectsDir);

  if (activeProcesses.length === 0) {
    return [];
  }

  const candidates = listClaudeProjectSessions(projectsDir);

  if (candidates.length === 0) {
    return [];
  }

  const candidatesByFile = new Map(
    candidates.map((candidate) => [candidate.filePath, candidate] as const),
  );
  const assignedFiles = new Set<string>();
  const discovered: DiscoveredClaudeSessionCandidate[] = [];
  const unmatchedProcesses: ActiveClaudeProcess[] = [];

  for (const process of activeProcesses) {
    const directMatch = pickNewestCandidate(
      process.sessionFiles
        .map((filePath) => candidatesByFile.get(filePath) ?? null)
        .filter(
          (candidate): candidate is DiscoveredClaudeSessionCandidate =>
            candidate !== null && !assignedFiles.has(candidate.filePath),
        ),
    );

    if (directMatch) {
      discovered.push(directMatch);
      assignedFiles.add(directMatch.filePath);
      continue;
    }

    if (process.cwd) {
      const cwdMatch = pickNewestCandidate(
        candidates.filter(
          (candidate) =>
            candidate.cwd === process.cwd && !assignedFiles.has(candidate.filePath),
        ),
      );

      if (cwdMatch) {
        discovered.push(cwdMatch);
        assignedFiles.add(cwdMatch.filePath);
        continue;
      }
    }

    unmatchedProcesses.push(process);
  }

  for (const _process of unmatchedProcesses) {
    const fallback = pickNewestCandidate(
      candidates.filter((candidate) => !assignedFiles.has(candidate.filePath)),
    );

    if (!fallback) {
      continue;
    }

    discovered.push(fallback);
    assignedFiles.add(fallback.filePath);
  }

  return discovered
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        right.mtimeMs - left.mtimeMs,
    )
    .map(({ filePath: _filePath, mtimeMs: _mtimeMs, ...session }) => session);
}

function pickNewestCandidate(
  candidates: DiscoveredClaudeSessionCandidate[],
): DiscoveredClaudeSessionCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      right.mtimeMs - left.mtimeMs,
  )[0]!;
}

function listActiveClaudeProcesses(projectsDir: string): ActiveClaudeProcess[] {
  const output = runCommand("ps", ["-axo", "pid=,comm=,command="]);

  if (!output) {
    return [];
  }

  const processes: ActiveClaudeProcess[] = [];

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const match = /^(\d+)\s+(\S+)\s+(.+)$/.exec(line);

    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const executableName = match[2];
    const command = match[3];

    if (!Number.isFinite(pid) || !isClaudeCliProcess(executableName, command)) {
      continue;
    }

    const details = inspectClaudeProcess(pid, projectsDir);
    processes.push({
      pid,
      cwd: details.cwd ? normalizeComparablePath(details.cwd) : null,
      sessionFiles: details.sessionFiles,
    });
  }

  return processes;
}

function inspectClaudeProcess(
  pid: number,
  projectsDir: string,
): { cwd: string | null; sessionFiles: string[] } {
  const output = runCommand("lsof", ["-Fn", "-p", String(pid)]);

  if (!output) {
    return {
      cwd: null,
      sessionFiles: [],
    };
  }

  let currentFileDescriptor: string | null = null;
  let cwd: string | null = null;
  const sessionFiles = new Set<string>();

  for (const rawLine of output.split("\n")) {
    if (rawLine.length < 2) {
      continue;
    }

    const prefix = rawLine[0];
    const value = rawLine.slice(1);

    if (prefix === "f") {
      currentFileDescriptor = value;
      continue;
    }

    if (prefix !== "n") {
      continue;
    }

    if (currentFileDescriptor === "cwd") {
      cwd = value;
      continue;
    }

    if (isClaudeProjectSessionFile(projectsDir, value)) {
      sessionFiles.add(value);
    }
  }

  return {
    cwd,
    sessionFiles: [...sessionFiles],
  };
}

function isClaudeCliProcess(executableName: string, command: string): boolean {
  const normalizedExecutable = path.basename(executableName).trim().toLowerCase();
  const normalizedCommand = command.trim().toLowerCase();

  if (normalizedExecutable === "claude") {
    return /(^|\s)(\/opt\/homebrew\/bin\/claude|\/usr\/local\/bin\/claude|claude)(\s|$)/.test(
      normalizedCommand,
    );
  }

  return (
    (normalizedExecutable === "node" || normalizedExecutable === "bun") &&
    normalizedCommand.includes("@anthropic-ai/claude-code/cli.js")
  );
}

function listClaudeProjectSessions(
  projectsDir: string,
): DiscoveredClaudeSessionCandidate[] {
  let entries: string[] = [];

  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }

  const sessions: DiscoveredClaudeSessionCandidate[] = [];

  for (const entry of entries) {
    const projectDir = path.join(projectsDir, entry);

    let projectStats;
    try {
      projectStats = statSync(projectDir);
    } catch {
      continue;
    }

    if (!projectStats.isDirectory()) {
      continue;
    }

    let projectEntries: string[] = [];
    try {
      projectEntries = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const projectEntry of projectEntries) {
      const filePath = path.join(projectDir, projectEntry);

      if (!isClaudeProjectSessionFile(projectsDir, filePath)) {
        continue;
      }

      let fileStats;
      try {
        fileStats = statSync(filePath);
      } catch {
        continue;
      }

      if (!fileStats.isFile()) {
        continue;
      }

      const session = readClaudeProjectSession(filePath, fileStats.size, fileStats.mtimeMs);

      if (!session) {
        continue;
      }

      sessions.push(session);
    }
  }

  return sessions.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      right.mtimeMs - left.mtimeMs,
  );
}

function isClaudeProjectSessionFile(projectsDir: string, filePath: string): boolean {
  return (
    filePath.startsWith(`${projectsDir}${path.sep}`) &&
    filePath.endsWith(".jsonl") &&
    !filePath.includes(`${path.sep}subagents${path.sep}`)
  );
}

function readClaudeProjectSession(
  filePath: string,
  size: number,
  mtimeMs: number,
): DiscoveredClaudeSessionCandidate | null {
  const preview = readJsonlPreview(filePath, size);

  if (!preview) {
    return null;
  }

  const records = parseJsonObjectLines(preview);
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd: string | null = null;
  let permissionMode: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let updatedAt = new Date(mtimeMs).toISOString();

  for (const record of records) {
    const recordSessionId = readString(record, "sessionId");
    if (recordSessionId) {
      sessionId = recordSessionId;
    }

    const recordCwd = readString(record, "cwd");
    if (recordCwd) {
      cwd = normalizeComparablePath(recordCwd);
    }

    const recordPermissionMode = readString(record, "permissionMode");
    if (recordPermissionMode) {
      permissionMode = recordPermissionMode;
    }

    const recordGitBranch = readString(record, "gitBranch");
    if (recordGitBranch) {
      gitBranch = recordGitBranch;
    }

    const recordVersion = readString(record, "version");
    if (recordVersion) {
      version = recordVersion;
    }

    const recordTimestamp = readString(record, "timestamp");
    if (recordTimestamp) {
      const parsedTimestamp = Date.parse(recordTimestamp);

      if (Number.isFinite(parsedTimestamp)) {
        updatedAt = new Date(Math.max(parsedTimestamp, mtimeMs)).toISOString();
      }
    }
  }

  if (!cwd) {
    return null;
  }

  return {
    filePath,
    mtimeMs,
    sessionId,
    sessionPath: filePath,
    cwd,
    displayName: path.basename(cwd) || sessionId.slice(0, 8),
    updatedAt,
    permissionMode,
    gitBranch,
    version,
  };
}

function readJsonlPreview(filePath: string, size: number): string {
  const fd = openSync(filePath, "r");

  try {
    if (size <= PREVIEW_BYTES * 2) {
      const buffer = Buffer.alloc(size);
      const bytesRead = readSync(fd, buffer, 0, size, 0);
      return buffer.toString("utf8", 0, bytesRead);
    }

    const headBuffer = Buffer.alloc(PREVIEW_BYTES);
    const headBytesRead = readSync(fd, headBuffer, 0, PREVIEW_BYTES, 0);
    const tailBuffer = Buffer.alloc(PREVIEW_BYTES);
    const tailBytesRead = readSync(
      fd,
      tailBuffer,
      0,
      PREVIEW_BYTES,
      Math.max(0, size - PREVIEW_BYTES),
    );

    return `${headBuffer.toString("utf8", 0, headBytesRead)}\n${tailBuffer.toString("utf8", 0, tailBytesRead)}`;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function parseJsonObjectLines(content: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (!line.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;

      if (isRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return records;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeComparablePath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function describeClaudePhase(
  permissionMode: string | null,
  controlState: ClaudeControlState,
): string {
  if (controlState === "auth_required") {
    return "auth required";
  }

  if (controlState === "unavailable") {
    return "control unavailable";
  }

  if (!permissionMode) {
    return "active session";
  }

  return permissionMode === "bypassPermissions"
    ? "bypass permissions"
    : permissionMode.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function buildLiveClaudeMessage(
  session: DiscoveredClaudeSession,
  controlState: ClaudeControlState,
): string {
  if (controlState === "auth_required") {
    return `Live Claude Code session discovered from ${session.cwd}, but the local Claude CLI is not logged in. Run claude auth login before using prompt dispatch.`;
  }

  if (controlState === "unavailable") {
    return `Live Claude Code session discovered from ${session.cwd}, but Agent Hub cannot verify a usable local Claude CLI for runtime control.`;
  }

  const details: string[] = [];

  if (session.gitBranch) {
    details.push(`branch ${session.gitBranch}`);
  }

  if (session.permissionMode) {
    details.push(`mode ${session.permissionMode}`);
  }

  if (session.version) {
    details.push(`Claude Code ${session.version}`);
  }

  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `Live Claude Code CLI session discovered from ${session.cwd}${suffix}.`;
}

function describeClaudeAgentHealth(controlState: ClaudeControlState) {
  switch (controlState) {
    case "auth_required":
      return "auth_required" as const;
    case "unavailable":
      return "unavailable" as const;
    default:
      return "healthy" as const;
  }
}

function describeClaudeAgentAttention(controlState: ClaudeControlState) {
  return controlState === "ready" ? ("silent" as const) : ("action_needed" as const);
}

function getClaudeControlState(claudeBin: string): ClaudeControlState {
  const authStatus = readClaudeAuthStatus(claudeBin);
  if (!authStatus) {
    return "unavailable";
  }

  return authStatus.loggedIn ? "ready" : "auth_required";
}

function readClaudeAuthStatus(
  claudeBin: string,
): { loggedIn: boolean } | null {
  let output: string | null = null;

  try {
    output = execFileSync(claudeBin, ["auth", "status"], {
      encoding: "utf8",
      maxBuffer: 1_000_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    output = readProcessStdout(error);
  }

  if (!output) {
    return null;
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.loggedIn === "boolean"
    ) {
      return {
        loggedIn: parsed.loggedIn,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function readProcessStdout(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("stdout" in error)) {
    return null;
  }

  const value = error.stdout;
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

function runCommand(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 10_000_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}
