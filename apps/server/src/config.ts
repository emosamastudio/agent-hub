import path from "node:path";
import { fileURLToPath } from "node:url";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..");

type Env = Record<string, string | undefined>;

export function createServerConfig(env: Env = process.env) {
  return {
    appRoot,
    host: env.AGENT_HUB_HOST ?? "127.0.0.1",
    port: parsePositiveInt(env.AGENT_HUB_PORT, 8788),
    databaseUrl: env.DATABASE_URL ?? "postgres://agent_hub:agent_hub_dev@localhost:5433/agent_hub",
    dashboardUsername: env.AGENT_HUB_DASHBOARD_USER ?? "admin",
    dashboardPassword: env.AGENT_HUB_DASHBOARD_PASSWORD ?? "admin",
    defaultProjectApiKey: env.AGENT_HUB_DEFAULT_API_KEY ?? "agent_hub_dev_key",
    schedulerTickMs: parsePositiveInt(env.AGENT_HUB_SCHEDULER_TICK_MS, 1000),
    executionRetentionDays: parsePositiveInt(env.AGENT_HUB_EXECUTION_RETENTION_DAYS, 90),
    traceRetentionDays: parsePositiveInt(env.AGENT_HUB_TRACE_RETENTION_DAYS, 30),
    alertRetentionDays: parsePositiveInt(env.AGENT_HUB_ALERT_RETENTION_DAYS, 180),
    maxTriggerDepth: parsePositiveInt(env.AGENT_HUB_MAX_TRIGGER_DEPTH, 5),
  } as const;
}

export const serverConfig = createServerConfig();
