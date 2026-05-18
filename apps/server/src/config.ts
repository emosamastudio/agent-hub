import path from "node:path";
import { fileURLToPath } from "node:url";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..");

export const serverConfig = {
  appRoot,
  host: process.env.AGENT_HUB_HOST ?? "0.0.0.0",
  port: parsePositiveInt(process.env.AGENT_HUB_PORT, 8787),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://agent_hub:agent_hub_dev@localhost:5433/agent_hub",
  dashboardPassword: process.env.AGENT_HUB_DASHBOARD_PASSWORD ?? "admin",
  schedulerTickMs: parsePositiveInt(process.env.AGENT_HUB_SCHEDULER_TICK_MS, 1000),
  executionRetentionDays: parsePositiveInt(process.env.AGENT_HUB_EXECUTION_RETENTION_DAYS, 90),
  traceRetentionDays: parsePositiveInt(process.env.AGENT_HUB_TRACE_RETENTION_DAYS, 30),
  alertRetentionDays: parsePositiveInt(process.env.AGENT_HUB_ALERT_RETENTION_DAYS, 180),
  maxTriggerDepth: parsePositiveInt(process.env.AGENT_HUB_MAX_TRIGGER_DEPTH, 5),
} as const;
