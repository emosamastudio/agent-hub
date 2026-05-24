import path from "node:path";
import { fileURLToPath } from "node:url";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDirectory, "..");
export const defaultDatabaseUrl = "postgres://agent_hub:agent_hub_dev@localhost:5433/agent_hub";
const defaultDashboardUsername = "admin";
const defaultDashboardPassword = "admin";
const defaultProjectApiKey = "agent_hub_dev_key";

type Env = Record<string, string | undefined>;

export function createServerConfig(env: Env = process.env) {
  const production = env.NODE_ENV === "production";
  const bootstrapDefaultProject = parseBoolean(
    env.AGENT_HUB_BOOTSTRAP_DEFAULT_PROJECT,
    !production,
  );
  const seedDemoAgent = parseBoolean(
    env.AGENT_HUB_SEED_DEMO_AGENT,
    bootstrapDefaultProject && !production,
  );

  const config = {
    appRoot,
    host: env.AGENT_HUB_HOST ?? "127.0.0.1",
    port: parsePositiveInt(env.AGENT_HUB_PORT, 8788),
    databaseUrl: env.DATABASE_URL ?? defaultDatabaseUrl,
    dashboardUsername: env.AGENT_HUB_DASHBOARD_USER ?? defaultDashboardUsername,
    dashboardPassword: env.AGENT_HUB_DASHBOARD_PASSWORD ?? defaultDashboardPassword,
    defaultProjectApiKey: env.AGENT_HUB_DEFAULT_API_KEY ?? defaultProjectApiKey,
    schedulerTickMs: parsePositiveInt(env.AGENT_HUB_SCHEDULER_TICK_MS, 1000),
    executionRetentionDays: parsePositiveInt(env.AGENT_HUB_EXECUTION_RETENTION_DAYS, 90),
    traceRetentionDays: parsePositiveInt(env.AGENT_HUB_TRACE_RETENTION_DAYS, 30),
    alertRetentionDays: parsePositiveInt(env.AGENT_HUB_ALERT_RETENTION_DAYS, 180),
    maxTriggerDepth: parsePositiveInt(env.AGENT_HUB_MAX_TRIGGER_DEPTH, 5),
    proxyTokenExpirySeconds: parsePositiveInt(env.AGENT_HUB_PROXY_TOKEN_EXPIRY_SECONDS, 600),
    anthropicApiKey: env.AGENT_HUB_ANTHROPIC_API_KEY ?? "",
    anthropicEndpoint: env.AGENT_HUB_ANTHROPIC_ENDPOINT ?? "https://api.anthropic.com",
    openaiApiKey: env.AGENT_HUB_OPENAI_API_KEY ?? env.AGENT_HUB_ANTHROPIC_API_KEY ?? "",
    openaiEndpoint: env.AGENT_HUB_OPENAI_ENDPOINT ?? env.AGENT_HUB_ANTHROPIC_ENDPOINT ?? "https://api.openai.com",
    encryptionKey: env.AGENT_HUB_ENCRYPTION_KEY ?? "",
    bootstrapDefaultProject,
    seedDemoAgent,
  } as const;

  if (production) {
    validateProductionConfig(env, config);
  }

  return config;
}

function validateProductionConfig(
  env: Env,
  config: {
    databaseUrl: string;
    dashboardPassword: string;
    defaultProjectApiKey: string;
    anthropicApiKey: string;
  },
) {
  const invalidFields: string[] = [];

  if (!env.DATABASE_URL || config.databaseUrl === defaultDatabaseUrl) {
    invalidFields.push("DATABASE_URL");
  }
  if (!env.AGENT_HUB_DASHBOARD_PASSWORD || config.dashboardPassword === defaultDashboardPassword) {
    invalidFields.push("AGENT_HUB_DASHBOARD_PASSWORD");
  }
  if (!env.AGENT_HUB_DEFAULT_API_KEY || config.defaultProjectApiKey === defaultProjectApiKey) {
    invalidFields.push("AGENT_HUB_DEFAULT_API_KEY");
  }
  if (!env.AGENT_HUB_ANTHROPIC_API_KEY || config.anthropicApiKey === "") {
    invalidFields.push("AGENT_HUB_ANTHROPIC_API_KEY");
  }

  if (invalidFields.length > 0) {
    throw new Error(`Production Agent Hub config requires explicit non-development values for ${invalidFields.join(", ")}`);
  }
}

export const serverConfig = createServerConfig();
