import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..");
const workspaceRoot = path.resolve(appRoot, "../../..");

export const serverConfig = {
  appRoot,
  workspaceRoot,
  host: process.env.HOST ?? "0.0.0.0",
  port: parsePositiveInt(process.env.PORT, 8787),
  dbPath: path.join(appRoot, "data", "agent-hub.db"),
  enableMockRuntime: parseBoolean(process.env.AGENT_HUB_ENABLE_MOCK_RUNTIME, false),
  enableCopilotSessionDiscovery: parseBoolean(
    process.env.AGENT_HUB_ENABLE_COPILOT_DISCOVERY,
    true,
  ),
  enableClaudeCodeSessionDiscovery: parseBoolean(
    process.env.AGENT_HUB_ENABLE_CLAUDE_DISCOVERY,
    true,
  ),
  enableGeminiCliSessionDiscovery: parseBoolean(
    process.env.AGENT_HUB_ENABLE_GEMINI_DISCOVERY,
    true,
  ),
  enableOpenClawSessionDiscovery: parseBoolean(
    process.env.AGENT_HUB_ENABLE_OPENCLAW_DISCOVERY,
    true,
  ),
  copilotSessionStateDir:
    process.env.AGENT_HUB_COPILOT_SESSION_STATE_DIR ??
    path.join(os.homedir(), ".copilot", "session-state"),
  claudeProjectsDir:
    process.env.AGENT_HUB_CLAUDE_PROJECTS_DIR ??
    path.join(os.homedir(), ".claude", "projects"),
  geminiStateDir:
    process.env.AGENT_HUB_GEMINI_STATE_DIR ??
    path.join(os.homedir(), ".gemini"),
  openClawStateDir:
    process.env.AGENT_HUB_OPENCLAW_STATE_DIR ??
    path.join(os.homedir(), ".openclaw"),
  copilotBin:
    process.env.AGENT_HUB_COPILOT_BIN ??
    (process.platform === "darwin" ? "/opt/homebrew/bin/copilot" : "copilot"),
  copilotSdkModulePath:
    process.env.AGENT_HUB_COPILOT_SDK_MODULE_PATH ??
    "/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/index.js",
  claudeBin:
    process.env.AGENT_HUB_CLAUDE_BIN ??
    (process.platform === "darwin" ? "/opt/homebrew/bin/claude" : "claude"),
  geminiBin:
    process.env.AGENT_HUB_GEMINI_BIN ??
    (process.platform === "darwin" ? "/opt/homebrew/bin/gemini" : "gemini"),
  openClawBin: process.env.AGENT_HUB_OPENCLAW_BIN ?? "openclaw",
  copilotSessionPollMs: parsePositiveInt(
    process.env.AGENT_HUB_COPILOT_POLL_MS,
    5_000,
  ),
  claudeCodeSessionPollMs: parsePositiveInt(
    process.env.AGENT_HUB_CLAUDE_POLL_MS,
    5_000,
  ),
  geminiCliSessionPollMs: parsePositiveInt(
    process.env.AGENT_HUB_GEMINI_POLL_MS,
    5_000,
  ),
  openClawSessionPollMs: parsePositiveInt(
    process.env.AGENT_HUB_OPENCLAW_POLL_MS,
    10_000,
  ),
  enableDesktopNotifications: parseBoolean(
    process.env.AGENT_HUB_ENABLE_DESKTOP_NOTIFICATIONS,
    process.platform === "darwin",
  ),
  desktopNotificationCooldownMs: parsePositiveInt(
    process.env.AGENT_HUB_NOTIFICATION_COOLDOWN_MS,
    90_000,
  ),
  simulationIntervalMs: parsePositiveInt(process.env.AGENT_HUB_SIM_INTERVAL_MS, 8_000),
  heartbeatIntervalMs: parsePositiveInt(process.env.AGENT_HUB_HEARTBEAT_MS, 15_000),
} as const;
