import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

import type { ControlPlaneService } from "./control-plane-service.js";
import type { HubNotifier } from "./notifier.js";

const GEMINI_AGENT_PREFIX = "gemini-session-";
const GEMINI_RUN_PREFIX = "gemini-run-";
const GEMINI_API_KEY_SERVICE = "gemini-cli-api-key";
const GEMINI_API_KEY_ACCOUNT = "default-api-key";

interface GeminiCliRuntimeOptions {
  geminiBin: string;
  geminiDir: string;
  enabled: boolean;
  logger: FastifyBaseLogger;
  notifier: HubNotifier;
  pollIntervalMs: number;
  service: ControlPlaneService;
}

export type GeminiControlState = "ready" | "auth_required" | "unavailable";

interface DiscoveredGeminiSessionCandidate extends DiscoveredGeminiSession {
  filePath: string;
  mtimeMs: number;
}

interface ActiveGeminiProcess {
  pid: number;
  cwd: string | null;
  sessionFiles: string[];
}

interface GeminiSessionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ParsedGeminiSessionFile {
  sessionId: string;
  startedAt: string | null;
  updatedAt: string | null;
  summary: string | null;
  messages: GeminiSessionMessage[];
}

export interface DiscoveredGeminiSession {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  displayName: string;
  summary: string | null;
  startedAt: string;
  updatedAt: string;
  toolVersion: string | null;
}

export class GeminiCliRuntimeService {
  private interval: NodeJS.Timeout | null = null;
  private lastFingerprint: string | null = null;

  constructor(private readonly options: GeminiCliRuntimeOptions) {}

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
      const geminiVersion = readGeminiVersion(this.options.geminiBin);
      const sessions = discoverGeminiSessions(this.options.geminiDir, geminiVersion);
      const controlState = getGeminiControlState(this.options.geminiDir);
      const fingerprint = JSON.stringify(
        sessions.map((session) => [
          session.sessionId,
          session.sessionPath,
          session.cwd,
          session.displayName,
          session.summary,
          session.startedAt,
          session.updatedAt,
          session.toolVersion,
          controlState,
        ]),
      );

      if (fingerprint === this.lastFingerprint) {
        return;
      }

      this.lastFingerprint = fingerprint;

      const knownGeminiAgents = this.options.service
        .listAgents()
        .filter((agent) => agent.id.startsWith(GEMINI_AGENT_PREFIX));
      const activeIds = new Set(sessions.map((session) => session.sessionId));

      for (const session of sessions) {
        const agentId = `${GEMINI_AGENT_PREFIX}${session.sessionId}`;
        const runId = `${GEMINI_RUN_PREFIX}${session.sessionId}`;
        const existingAgent = knownGeminiAgents.find((agent) => agent.id === agentId);
        const result = this.options.service.ingestUpdate({
          agent: {
            id: agentId,
            name: `Gemini CLI · ${session.displayName}`,
            platform: "gemini-cli",
            workspacePath: session.cwd,
            state: "running",
            health: describeGeminiAgentHealth(controlState),
            attention: describeGeminiAgentAttention(controlState),
            currentRunId: runId,
            lastHeartbeatAt: session.updatedAt,
            lastEventAt: session.updatedAt,
            sessionMetadata: {
              sessionId: session.sessionId,
              sessionPath: session.sessionPath,
              summary: session.summary,
              startedAt: session.startedAt,
              updatedAt: session.updatedAt,
              toolVersion: session.toolVersion,
            },
          },
          run: {
            id: runId,
            title: `Gemini CLI session · ${session.displayName}`,
            state: "running",
            health: describeGeminiAgentHealth(controlState),
            attention: describeGeminiAgentAttention(controlState),
            progress: {
              phase: describeGeminiPhase(controlState),
              percent: null,
              message: buildLiveGeminiMessage(session, controlState),
            },
            lastEventAt: session.updatedAt,
            createdAt: session.startedAt,
          },
          event: existingAgent
            ? existingAgent.state === "offline"
              ? {
                  type: "agent.recovered",
                  attention: "info",
                  message: `Gemini CLI session “${session.displayName}” is active again.`,
                  createdAt: session.updatedAt,
                }
              : undefined
            : {
                type: "session.opened",
                attention: "info",
                message: `Discovered live Gemini CLI session “${session.displayName}”.`,
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

      for (const agent of knownGeminiAgents) {
        const sessionId = agent.id.slice(GEMINI_AGENT_PREFIX.length);

        if (activeIds.has(sessionId)) {
          continue;
        }

        const runId = `${GEMINI_RUN_PREFIX}${sessionId}`;
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
        "Failed to synchronize Gemini CLI sessions",
      );
    }
  }
}

export function discoverGeminiSessions(
  geminiDir: string,
  geminiVersion: string | null,
): DiscoveredGeminiSession[] {
  const activeProcesses = listActiveGeminiProcesses(geminiDir);

  if (activeProcesses.length === 0) {
    return [];
  }

  const candidates = listGeminiProjectSessions(geminiDir, geminiVersion);

  if (candidates.length === 0) {
    return [];
  }

  const candidatesByFile = new Map(
    candidates.map((candidate) => [candidate.filePath, candidate] as const),
  );
  const assignedFiles = new Set<string>();
  const discovered: DiscoveredGeminiSessionCandidate[] = [];
  const unmatchedProcesses: ActiveGeminiProcess[] = [];

  for (const process of activeProcesses) {
    const directMatch = pickNewestGeminiCandidate(
      process.sessionFiles
        .map((filePath) => candidatesByFile.get(filePath) ?? null)
        .filter(
          (candidate): candidate is DiscoveredGeminiSessionCandidate =>
            candidate !== null && !assignedFiles.has(candidate.filePath),
        ),
    );

    if (directMatch) {
      discovered.push(directMatch);
      assignedFiles.add(directMatch.filePath);
      continue;
    }

    if (process.cwd) {
      const cwdMatch = pickNewestGeminiCandidate(
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
    const fallback = pickNewestGeminiCandidate(
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

export function readGeminiSessionFile(filePath: string): ParsedGeminiSessionFile | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      return null;
    }

    const sessionId =
      readString(parsed, "sessionId") ??
      path.basename(filePath, ".json").replace(/^session-/, "");
    const startedAt = readValidDateString(parsed, "startTime");
    const updatedAt = readValidDateString(parsed, "lastUpdated");
    const messages = readGeminiMessages(parsed.messages);
    const summary =
      normalizeText(readString(parsed, "summary")) ?? summarizeGeminiMessages(messages);

    return {
      sessionId,
      startedAt,
      updatedAt,
      summary,
      messages,
    };
  } catch {
    return null;
  }
}

export function getGeminiControlState(geminiDir: string): GeminiControlState {
  const authStatus = readGeminiAuthStatus(geminiDir);

  if (authStatus === "ready") {
    return "ready";
  }

  if (authStatus === "auth_required") {
    return "auth_required";
  }

  return "unavailable";
}

function pickNewestGeminiCandidate(
  candidates: DiscoveredGeminiSessionCandidate[],
): DiscoveredGeminiSessionCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      right.mtimeMs - left.mtimeMs,
  )[0]!;
}

function listActiveGeminiProcesses(geminiDir: string): ActiveGeminiProcess[] {
  const output = runCommand("ps", ["-axo", "pid=,comm=,command="]);

  if (!output) {
    return [];
  }

  const processes: ActiveGeminiProcess[] = [];

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

    if (!Number.isFinite(pid) || !isGeminiCliProcess(executableName, command)) {
      continue;
    }

    const details = inspectGeminiProcess(pid, geminiDir);
    processes.push({
      pid,
      cwd: details.cwd ? normalizeComparablePath(details.cwd) : null,
      sessionFiles: details.sessionFiles,
    });
  }

  return processes;
}

function inspectGeminiProcess(
  pid: number,
  geminiDir: string,
): { cwd: string | null; sessionFiles: string[] } {
  const output = runCommand("lsof", ["-Fn", "-p", String(pid)]);

  if (!output) {
    return {
      cwd: null,
      sessionFiles: [],
    };
  }

  const geminiTmpDir = path.join(geminiDir, "tmp");
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

    if (isGeminiSessionFile(geminiTmpDir, value)) {
      sessionFiles.add(value);
    }
  }

  return {
    cwd,
    sessionFiles: [...sessionFiles],
  };
}

function isGeminiCliProcess(executableName: string, command: string): boolean {
  const normalizedExecutable = path.basename(executableName).trim().toLowerCase();
  const normalizedCommand = command.trim().toLowerCase();

  if (
    normalizedExecutable === "gemini" ||
    /(^|\s)(\S*\/gemini|gemini)(\s|$)/.test(normalizedCommand)
  ) {
    return true;
  }

  return (
    /(^|\s)(\S*\/(node|bun)|node|bun)(\s|$)/.test(normalizedCommand) &&
    normalizedCommand.includes("@google/gemini-cli/dist/index.js")
  );
}

function listGeminiProjectSessions(
  geminiDir: string,
  geminiVersion: string | null,
): DiscoveredGeminiSessionCandidate[] {
  const tmpDir = path.join(geminiDir, "tmp");
  let entries: string[] = [];

  try {
    entries = readdirSync(tmpDir);
  } catch {
    return [];
  }

  const sessions: DiscoveredGeminiSessionCandidate[] = [];

  for (const entry of entries) {
    const projectDir = path.join(tmpDir, entry);

    let projectStats;
    try {
      projectStats = statSync(projectDir);
    } catch {
      continue;
    }

    if (!projectStats.isDirectory()) {
      continue;
    }

    const projectRoot = readProjectRoot(path.join(projectDir, ".project_root"));

    if (!projectRoot) {
      continue;
    }

    const chatsDir = path.join(projectDir, "chats");
    let chatEntries: string[] = [];
    try {
      chatEntries = readdirSync(chatsDir);
    } catch {
      continue;
    }

    for (const chatEntry of chatEntries) {
      const filePath = path.join(chatsDir, chatEntry);

      if (!isGeminiSessionFile(tmpDir, filePath)) {
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

      const session = readGeminiProjectSession(
        filePath,
        projectRoot,
        geminiVersion,
        fileStats.mtimeMs,
      );

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

function readGeminiProjectSession(
  filePath: string,
  cwd: string,
  geminiVersion: string | null,
  mtimeMs: number,
): DiscoveredGeminiSessionCandidate | null {
  const parsed = readGeminiSessionFile(filePath);

  if (!parsed) {
    return null;
  }

  const updatedAt = parsed.updatedAt
    ? new Date(Math.max(Date.parse(parsed.updatedAt), mtimeMs)).toISOString()
    : new Date(mtimeMs).toISOString();
  const startedAt = parsed.startedAt
    ? new Date(Math.min(Date.parse(parsed.startedAt), Date.parse(updatedAt))).toISOString()
    : updatedAt;

  return {
    filePath,
    mtimeMs,
    sessionId: parsed.sessionId,
    sessionPath: filePath,
    cwd,
    displayName: path.basename(cwd) || parsed.sessionId.slice(0, 8),
    summary: parsed.summary,
    startedAt,
    updatedAt,
    toolVersion: geminiVersion,
  };
}

function readProjectRoot(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    return raw.length > 0 ? normalizeComparablePath(raw) : null;
  } catch {
    return null;
  }
}

function isGeminiSessionFile(tmpDir: string, filePath: string): boolean {
  return (
    filePath.startsWith(`${tmpDir}${path.sep}`) &&
    filePath.includes(`${path.sep}chats${path.sep}`) &&
    path.basename(filePath).startsWith("session-") &&
    filePath.endsWith(".json")
  );
}

function readGeminiMessages(value: unknown): GeminiSessionMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const messages: GeminiSessionMessage[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const type = readString(entry, "type");
    const text = normalizeText(readGeminiContent(entry.content));

    if (!text) {
      continue;
    }

    if (type === "user") {
      messages.push({
        role: "user",
        text,
      });
      continue;
    }

    if (type === "gemini" || type === "assistant") {
      messages.push({
        role: "assistant",
        text,
      });
    }
  }

  return messages;
}

function summarizeGeminiMessages(messages: GeminiSessionMessage[]): string | null {
  const firstUserMessage = messages.find((message) => message.role === "user");
  return firstUserMessage ? truncateText(firstUserMessage.text, 120) : null;
}

function readGeminiContent(value: unknown, depth = 0): string | null {
  if (depth > 4) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const combined = value
      .map((entry) => readGeminiContent(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry))
      .join(" ")
      .trim();
    return combined.length > 0 ? combined : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const directText = readString(value, "text");
  if (directText) {
    return directText;
  }

  const directValue = readString(value, "value");
  if (directValue) {
    return directValue;
  }

  return (
    readGeminiContent(value.content, depth + 1) ??
    readGeminiContent(value.parts, depth + 1) ??
    readGeminiContent(value.items, depth + 1)
  );
}

function describeGeminiPhase(controlState: GeminiControlState): string {
  switch (controlState) {
    case "auth_required":
      return "auth required";
    case "unavailable":
      return "control unavailable";
    default:
      return "active session";
  }
}

function buildLiveGeminiMessage(
  session: DiscoveredGeminiSession,
  controlState: GeminiControlState,
): string {
  if (controlState === "auth_required") {
    return `Live Gemini CLI session discovered from ${session.cwd}, but the local Gemini CLI auth method is not configured. Set Gemini auth before using prompt dispatch.`;
  }

  if (controlState === "unavailable") {
    return `Live Gemini CLI session discovered from ${session.cwd}, but Agent Hub cannot verify a usable local Gemini CLI auth posture for runtime control.`;
  }

  const details: string[] = [];

  if (session.summary) {
    details.push(`latest focus: ${session.summary}`);
  }

  if (session.toolVersion) {
    details.push(`Gemini CLI ${session.toolVersion}`);
  }

  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `Live Gemini CLI session discovered from ${session.cwd}${suffix}.`;
}

function describeGeminiAgentHealth(controlState: GeminiControlState) {
  switch (controlState) {
    case "auth_required":
      return "auth_required" as const;
    case "unavailable":
      return "unavailable" as const;
    default:
      return "healthy" as const;
  }
}

function describeGeminiAgentAttention(controlState: GeminiControlState) {
  return controlState === "ready" ? ("silent" as const) : ("action_needed" as const);
}

function readGeminiAuthStatus(geminiDir: string): GeminiControlState {
  const authType = getGeminiAuthTypeFromEnv() ?? readGeminiAuthTypeFromSettings(geminiDir);

  if (!authType) {
    return "auth_required";
  }

  switch (authType) {
    case "oauth-personal":
      return hasGeminiGoogleAuthFiles(geminiDir) ? "ready" : "auth_required";
    case "gemini-api-key":
      return hasGeminiApiKey() ? "ready" : "auth_required";
    case "vertex-ai":
      return hasVertexAiAuth() ? "ready" : "auth_required";
    default:
      return "unavailable";
  }
}

function getGeminiAuthTypeFromEnv(): string | null {
  if (process.env.GOOGLE_GENAI_USE_GCA === "true") {
    return "oauth-personal";
  }

  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    return "vertex-ai";
  }

  if (process.env.GEMINI_API_KEY) {
    return "gemini-api-key";
  }

  return null;
}

function readGeminiAuthTypeFromSettings(geminiDir: string): string | null {
  try {
    const raw = readFileSync(path.join(geminiDir, "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      return null;
    }

    const merged = readRecord(parsed, "merged");
    const security = readRecord(merged ?? parsed, "security");
    const auth = readRecord(security, "auth");

    return normalizeText(
      readString(auth, "selectedType") ??
        readString(security, "selectedType") ??
        readString(parsed, "selectedAuthType"),
    );
  } catch {
    return null;
  }
}

function hasGeminiGoogleAuthFiles(geminiDir: string): boolean {
  return (
    hasRegularFile(path.join(geminiDir, "oauth_creds.json")) ||
    hasRegularFile(path.join(geminiDir, "google_accounts.json"))
  );
}

function hasGeminiApiKey(): boolean {
  if (process.env.GEMINI_API_KEY) {
    return true;
  }

  if (process.platform !== "darwin") {
    return false;
  }

  try {
    execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        GEMINI_API_KEY_SERVICE,
        "-a",
        GEMINI_API_KEY_ACCOUNT,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

function hasVertexAiAuth(): boolean {
  if (process.env.GOOGLE_API_KEY) {
    return true;
  }

  const project =
    process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID ?? null;
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? null;

  return Boolean(project && location);
}

function readGeminiVersion(geminiBin: string): string | null {
  const output = runCommand(geminiBin, ["--version"]);

  if (!output) {
    return null;
  }

  return normalizeText(output.split("\n")[0] ?? null);
}

function hasRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) {
    return null;
  }

  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readValidDateString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = readString(record, key);

  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function readRecord(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!record) {
    return null;
  }

  const value = record[key];
  return isRecord(value) ? value : null;
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
