#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  AgentHubControlClient,
  type AgentHubArchiveFilter,
  type AgentHubAcknowledgeAlertOptions,
  type AgentHubAgentType,
  type AgentHubControlConfig,
  type AgentHubCreateProjectInput,
  type AgentHubCreateAgentInput,
  type AgentHubDedupPolicy,
  type AgentHubDrainAgentOptions,
  type AgentHubGetAgentOptions,
  type AgentHubListAgentsQuery,
  type AgentHubListAlertsQuery,
  type AgentHubListExecutionsQuery,
  type AgentHubListExecutorsQuery,
  type AgentHubMisfirePolicy,
  type AgentHubSchedulePreviewOptions,
  type AgentHubSchedulerStatusQuery,
  type AgentHubTriggerOptions,
  type AgentHubUpdateAgentInput,
  type AgentHubWaitExecutionOptions,
} from "./index.js";

type Env = Record<string, string | undefined>;
type CliFlagValue = string | boolean;
type CliFlags = Record<string, CliFlagValue>;

type CliInvocation =
  | { command: "help" }
  | { command: "health" }
  | { command: "ready" }
  | { command: "projects:list" }
  | { command: "projects:ensure"; input: AgentHubCreateProjectInput }
  | { command: "projects:create"; input: AgentHubCreateProjectInput }
  | { command: "projects:rotate-key"; projectId: string }
  | { command: "scheduler:status"; query: AgentHubSchedulerStatusQuery }
  | { command: "executors:list"; query: AgentHubListExecutorsQuery }
  | { command: "alerts:list"; query: AgentHubListAlertsQuery }
  | { command: "alerts:acknowledge"; alertId: number; options: AgentHubAcknowledgeAlertOptions }
  | { command: "agents:list"; query: AgentHubListAgentsQuery }
  | { command: "agents:get"; agentId: string; options: AgentHubGetAgentOptions }
  | { command: "agents:create"; input: AgentHubCreateAgentInput }
  | { command: "agents:update"; agentId: string; patch: AgentHubUpdateAgentInput }
  | { command: "agents:schedule-preview"; agentId: string; options: AgentHubSchedulePreviewOptions }
  | { command: "agents:set-enabled"; agentId: string; enabled: boolean }
  | { command: "agents:delete"; agentId: string }
  | { command: "agents:drain"; agentId: string; options: AgentHubDrainAgentOptions }
  | { command: "executions:list"; query: AgentHubListExecutionsQuery }
  | { command: "executions:get"; executionId: string }
  | { command: "executions:wait"; executionId: string; options: AgentHubWaitExecutionOptions }
  | { command: "executions:cancel"; executionId: string }
  | { command: "executions:rerun"; executionId: string }
  | { command: "traces:list"; executionId: string }
  | { command: "trigger"; agentName: string; options: AgentHubTriggerOptions };

interface ParsedArgs {
  positionals: string[];
  flags: CliFlags;
}

interface CliIO {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

const DEFAULT_URL = "http://127.0.0.1:8788";
const DEFAULT_API_KEY = "agent_hub_dev_key";
const DEFAULT_DASHBOARD_USER = "admin";
const DEFAULT_DASHBOARD_PASSWORD = "admin";

export function buildControlConfig(env: Env = process.env, flags: CliFlags = {}): AgentHubControlConfig {
  return {
    serverUrl: stringFlag(flags, "url") ?? env.AGENT_HUB_URL ?? DEFAULT_URL,
    apiKey: stringFlag(flags, "api-key") ?? env.AGENT_HUB_API_KEY ?? DEFAULT_API_KEY,
    dashboardUsername: stringFlag(flags, "dashboard-user") ?? env.AGENT_HUB_DASHBOARD_USER ?? DEFAULT_DASHBOARD_USER,
    dashboardPassword: stringFlag(flags, "dashboard-password") ?? env.AGENT_HUB_DASHBOARD_PASSWORD ?? DEFAULT_DASHBOARD_PASSWORD,
  };
}

export function parseCliInvocation(argv: string[]): CliInvocation {
  const parsed = parseArgs(argv);
  const [root, subcommand, third] = parsed.positionals;

  if (!root || root === "help" || parsed.flags.help === true || parsed.flags.h === true) {
    return { command: "help" };
  }

  if (root === "health") {
    return { command: "health" };
  }

  if (root === "ready") {
    return { command: "ready" };
  }

  if (root === "projects") {
    if (!subcommand || subcommand === "list") {
      return { command: "projects:list" };
    }
    if (subcommand === "ensure") {
      if (!third) throw new Error("Usage: agent-hub projects ensure <project-name> [--display-name <name>] [--description <text>]");
      return {
        command: "projects:ensure",
        input: compactDefined({
          name: third,
          displayName: stringFlag(parsed.flags, "display-name"),
          description: stringFlag(parsed.flags, "description"),
          apiKey: stringFlag(parsed.flags, "api-key-value"),
        }),
      };
    }
    if (subcommand === "create") {
      if (!third) throw new Error("Usage: agent-hub projects create <project-name> [--display-name <name>] [--description <text>]");
      return {
        command: "projects:create",
        input: compactDefined({
          name: third,
          displayName: stringFlag(parsed.flags, "display-name"),
          description: stringFlag(parsed.flags, "description"),
          apiKey: stringFlag(parsed.flags, "api-key-value"),
        }),
      };
    }
    if (subcommand === "rotate-key") {
      if (!third) throw new Error("Usage: agent-hub projects rotate-key <project-id>");
      return {
        command: "projects:rotate-key",
        projectId: third,
      };
    }
    throw new Error(`Unknown projects command: ${subcommand}`);
  }

  if (root === "scheduler") {
    if (!subcommand || subcommand === "status") {
      return {
        command: "scheduler:status",
        query: compactQuery({
          project: stringFlag(parsed.flags, "project"),
          agent_id: stringFlag(parsed.flags, "agent-id"),
        }),
      };
    }
    throw new Error(`Unknown scheduler command: ${subcommand}`);
  }

  if (root === "executors") {
    if (!subcommand || subcommand === "list") {
      return {
        command: "executors:list",
        query: compactQuery({
          project: stringFlag(parsed.flags, "project"),
        }),
      };
    }
    throw new Error(`Unknown executors command: ${subcommand}`);
  }

  if (root === "alerts") {
    if (!subcommand || subcommand === "list") {
      return {
        command: "alerts:list",
        query: compactDefined({
          limit: positiveNumberFlag(parsed.flags, "limit"),
          includeAcknowledged: parsed.flags["include-acknowledged"] === true ? true : undefined,
        }),
      };
    }
    if (subcommand === "acknowledge") {
      if (!third) throw new Error("Usage: agent-hub alerts acknowledge <alert-id> [--by <actor>]");
      return {
        command: "alerts:acknowledge",
        alertId: parsePositiveInteger(third, "alert-id"),
        options: compactDefined({
          acknowledgedBy: stringFlag(parsed.flags, "by"),
        }),
      };
    }
    throw new Error(`Unknown alerts command: ${subcommand}`);
  }

  if (root === "agents") {
    if (!subcommand || subcommand === "list") {
      return {
        command: "agents:list",
        query: compactQuery({
          project: stringFlag(parsed.flags, "project"),
          type: stringFlag(parsed.flags, "type"),
          status: stringFlag(parsed.flags, "status"),
          archived: parseArchiveFilter(stringFlag(parsed.flags, "archived")),
        }),
      };
    }
    if (subcommand === "get") {
      if (!third) throw new Error("Usage: agent-hub agents get <agent-id> [--include-archived]");
      return {
        command: "agents:get",
        agentId: third,
        options: compactDefined({
          includeArchived: parsed.flags["include-archived"] === true ? true : undefined,
        }),
      };
    }
    if (subcommand === "create") {
      if (!third) throw new Error("Usage: agent-hub agents create <agent-name> --display-name <name>");
      const displayName = stringFlag(parsed.flags, "display-name");
      if (!displayName) throw new Error("Usage: agent-hub agents create <agent-name> --display-name <name>");
      return {
        command: "agents:create",
        input: compactDefined({
          projectId: stringFlag(parsed.flags, "project-id"),
          name: third,
          displayName,
          agentType: parseAgentType(stringFlag(parsed.flags, "type")),
          cronExpression: stringFlag(parsed.flags, "cron"),
          handlerName: stringFlag(parsed.flags, "handler"),
          enabled: parsed.flags.disabled === true ? false : booleanFlag(parsed.flags, "enabled"),
          misfirePolicy: parseMisfirePolicy(stringFlag(parsed.flags, "misfire-policy")),
          concurrency: numberFlag(parsed.flags, "concurrency"),
          maxPendingQueue: numberFlag(parsed.flags, "max-pending-queue"),
          timeoutSeconds: numberFlag(parsed.flags, "timeout-seconds"),
          retryMax: numberFlag(parsed.flags, "retry-max"),
          retryBackoffBaseMs: numberFlag(parsed.flags, "retry-backoff-base-ms"),
          maxTurns: numberFlag(parsed.flags, "max-turns"),
          maxCostUsd: decimalFlag(parsed.flags, "max-cost-usd"),
          inputSchema: recordFlag(parsed.flags, "input-schema"),
          allowTriggerBy: recordFlag(parsed.flags, "allow-trigger-by"),
          idempotencyWindowSeconds: numberFlag(parsed.flags, "idempotency-window-seconds"),
          labels: stringRecordFlag(parsed.flags, "labels"),
        }),
      };
    }
    if (subcommand === "update") {
      if (!third) throw new Error("Usage: agent-hub agents update <agent-id> [settings]");
      const patch = compactDefined({
        displayName: stringFlag(parsed.flags, "display-name"),
        description: parsed.flags["clear-description"] === true ? null : stringFlag(parsed.flags, "description"),
        cronExpression: parsed.flags["clear-cron"] === true ? null : stringFlag(parsed.flags, "cron"),
        handlerName: parsed.flags["clear-handler"] === true ? null : stringFlag(parsed.flags, "handler"),
        enabled: booleanFlag(parsed.flags, "enabled"),
        misfirePolicy: parseMisfirePolicy(stringFlag(parsed.flags, "misfire-policy")),
        concurrency: numberFlag(parsed.flags, "concurrency"),
        maxPendingQueue: numberFlag(parsed.flags, "max-pending-queue"),
        timeoutSeconds: numberFlag(parsed.flags, "timeout-seconds"),
        retryMax: numberFlag(parsed.flags, "retry-max"),
        retryBackoffBaseMs: numberFlag(parsed.flags, "retry-backoff-base-ms"),
        maxTurns: parsed.flags["clear-max-turns"] === true ? null : numberFlag(parsed.flags, "max-turns"),
        maxCostUsd: parsed.flags["clear-max-cost-usd"] === true ? null : decimalFlag(parsed.flags, "max-cost-usd"),
        executorHost: parsed.flags["clear-executor-host"] === true ? null : stringFlag(parsed.flags, "executor-host"),
        inputSchema: parsed.flags["clear-input-schema"] === true ? null : recordFlag(parsed.flags, "input-schema"),
        allowTriggerBy: parsed.flags["clear-allow-trigger-by"] === true ? null : recordFlag(parsed.flags, "allow-trigger-by"),
        idempotencyWindowSeconds: numberFlag(parsed.flags, "idempotency-window-seconds"),
        labels: stringRecordFlag(parsed.flags, "labels"),
      });
      if (Object.keys(patch).length === 0) {
        throw new Error("Usage: agent-hub agents update <agent-id> [settings]");
      }
      return {
        command: "agents:update",
        agentId: third,
        patch,
      };
    }
    if (subcommand === "schedule-preview") {
      if (!third) throw new Error("Usage: agent-hub agents schedule-preview <agent-id> [--limit 5]");
      return {
        command: "agents:schedule-preview",
        agentId: third,
        options: compactDefined({
          limit: positiveNumberFlag(parsed.flags, "limit"),
        }),
      };
    }
    if (subcommand === "enable" || subcommand === "disable") {
      if (!third) throw new Error(`Usage: agent-hub agents ${subcommand} <agent-id>`);
      return {
        command: "agents:set-enabled",
        agentId: third,
        enabled: subcommand === "enable",
      };
    }
    if (subcommand === "delete") {
      if (!third) throw new Error("Usage: agent-hub agents delete <agent-id>");
      return {
        command: "agents:delete",
        agentId: third,
      };
    }
    if (subcommand === "drain") {
      if (!third) throw new Error("Usage: agent-hub agents drain <agent-id> [--cancel-running]");
      return {
        command: "agents:drain",
        agentId: third,
        options: {
          cancelRunning: parsed.flags["cancel-running"] === true,
        },
      };
    }
    throw new Error(`Unknown agents command: ${subcommand}`);
  }

  if (root === "executions") {
    if (!subcommand || subcommand === "list") {
      return {
        command: "executions:list",
        query: compactQuery({
          agent_id: stringFlag(parsed.flags, "agent-id"),
          status: stringFlag(parsed.flags, "status"),
          trigger_type: stringFlag(parsed.flags, "trigger-type"),
          since: stringFlag(parsed.flags, "since"),
          limit: numberFlag(parsed.flags, "limit"),
          offset: numberFlag(parsed.flags, "offset"),
        }),
      };
    }
    if (subcommand === "get") {
      if (!third) throw new Error("Usage: agent-hub executions get <execution-id>");
      return { command: "executions:get", executionId: third };
    }
    if (subcommand === "wait") {
      if (!third) throw new Error("Usage: agent-hub executions wait <execution-id> [--timeout-ms 600000] [--interval-ms 1000]");
      return {
        command: "executions:wait",
        executionId: third,
        options: compactDefined({
          timeoutMs: numberFlag(parsed.flags, "timeout-ms"),
          intervalMs: numberFlag(parsed.flags, "interval-ms"),
          requireSuccess: parsed.flags["require-success"] === true ? true : undefined,
        }),
      };
    }
    if (subcommand === "cancel") {
      if (!third) throw new Error("Usage: agent-hub executions cancel <execution-id>");
      return { command: "executions:cancel", executionId: third };
    }
    if (subcommand === "rerun") {
      if (!third) throw new Error("Usage: agent-hub executions rerun <execution-id>");
      return { command: "executions:rerun", executionId: third };
    }
    throw new Error(`Unknown executions command: ${subcommand}`);
  }

  if (root === "traces") {
    if (subcommand !== "list" || !third) {
      throw new Error("Usage: agent-hub traces list <execution-id>");
    }
    return { command: "traces:list", executionId: third };
  }

  if (root === "trigger") {
    if (!subcommand) throw new Error("Usage: agent-hub trigger <agent-name> [--payload '{...}']");
    return {
      command: "trigger",
      agentName: subcommand,
      options: compactQuery({
        payload: parsePayload(stringFlag(parsed.flags, "payload")),
        idempotencyKey: stringFlag(parsed.flags, "idempotency-key"),
        dedupPolicy: parseDedupPolicy(stringFlag(parsed.flags, "dedup-policy")),
      }),
    };
  }

  throw new Error(`Unknown command: ${root}`);
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: Env = process.env,
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const invocation = parseCliInvocation(argv);
    if (invocation.command === "help") {
      io.stdout.write(helpText());
      return 0;
    }

    const { flags } = parseArgs(argv);
    const client = new AgentHubControlClient(buildControlConfig(env, flags));
    const result = await executeInvocation(client, invocation);
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function executeInvocation(client: AgentHubControlClient, invocation: CliInvocation): Promise<unknown> {
  switch (invocation.command) {
    case "health":
      return client.health();
    case "ready":
      return client.ready();
    case "projects:list":
      return client.listProjects();
    case "projects:ensure":
      return client.ensureProject(invocation.input);
    case "projects:create":
      return client.createProject(invocation.input);
    case "projects:rotate-key":
      return client.rotateProjectApiKey(invocation.projectId);
    case "scheduler:status":
      return client.getSchedulerStatus(invocation.query);
    case "executors:list":
      return client.listExecutors(invocation.query);
    case "alerts:list":
      return client.listAlerts(invocation.query);
    case "alerts:acknowledge":
      return client.acknowledgeAlert(invocation.alertId, invocation.options);
    case "agents:list":
      return client.listAgents(invocation.query);
    case "agents:get":
      return client.getAgent(invocation.agentId, invocation.options);
    case "agents:create":
      return client.createAgent(invocation.input);
    case "agents:update":
      return client.updateAgent(invocation.agentId, invocation.patch);
    case "agents:schedule-preview":
      return client.getAgentSchedulePreview(invocation.agentId, invocation.options);
    case "agents:set-enabled":
      return client.setAgentEnabled(invocation.agentId, invocation.enabled);
    case "agents:delete":
      return client.deleteAgent(invocation.agentId);
    case "agents:drain":
      return client.drainAgent(invocation.agentId, invocation.options);
    case "executions:list":
      return client.listExecutions(invocation.query);
    case "executions:get":
      return client.getExecution(invocation.executionId);
    case "executions:wait":
      return client.waitForExecution(invocation.executionId, invocation.options);
    case "executions:cancel":
      return client.cancelExecution(invocation.executionId);
    case "executions:rerun":
      return client.rerunExecution(invocation.executionId);
    case "traces:list":
      return client.getExecutionTraces(invocation.executionId);
    case "trigger":
      return client.triggerAgent(invocation.agentName, invocation.options);
    case "help":
      return {};
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: CliFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }

    const normalized = arg.replace(/^-+/, "");
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex !== -1) {
      flags[normalized.slice(0, equalsIndex)] = normalized.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("-")) {
      flags[normalized] = next;
      index += 1;
    } else {
      flags[normalized] = true;
    }
  }

  return { positionals, flags };
}

function stringFlag(flags: CliFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFlag(flags: CliFlags, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function positiveNumberFlag(flags: CliFlags, name: string): number | undefined {
  const parsed = numberFlag(flags, name);
  if (parsed === undefined) return undefined;
  if (parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function decimalFlag(flags: CliFlags, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return parsed;
}

function booleanFlag(flags: CliFlags, name: string): boolean | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (value === false) return false;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error(`--${name} must be true or false`);
}

function parseAgentType(value: string | undefined): AgentHubAgentType | undefined {
  if (value === undefined) return undefined;
  if (value === "cron_task" || value === "llm_agent") return value;
  throw new Error("--type must be one of cron_task, llm_agent");
}

function parseMisfirePolicy(value: string | undefined): AgentHubMisfirePolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "fire_once" || value === "fire_all" || value === "drop") return value;
  throw new Error("--misfire-policy must be one of fire_once, fire_all, drop");
}

function parseArchiveFilter(value: string | undefined): AgentHubArchiveFilter | undefined {
  if (value === undefined) return undefined;
  if (value === "active" || value === "include" || value === "only") return value;
  throw new Error("--archived must be one of active, include, only");
}

function parsePayload(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function recordFlag(flags: CliFlags, name: string): Record<string, unknown> | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringRecordFlag(flags: CliFlags, name: string): Record<string, string> | undefined {
  const parsed = recordFlag(flags, name);
  if (parsed === undefined) return undefined;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`--${name}.${key} must be a string`);
    }
  }
  return parsed as Record<string, string>;
}

function parseDedupPolicy(value: string | undefined): AgentHubDedupPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "skip_if_running" || value === "skip_if_exists" || value === "allow_duplicate") {
    return value;
  }
  throw new Error("--dedup-policy must be one of skip_if_running, skip_if_exists, allow_duplicate");
}

function compactQuery<T extends Record<string, unknown>>(query: T): T {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      compacted[key] = value;
    }
  }
  return compacted as T;
}

function compactDefined<T extends Record<string, unknown>>(query: T): T {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted as T;
}

function helpText(): string {
  return `Usage:
  agent-hub health
  agent-hub ready
  agent-hub projects list
  agent-hub projects ensure <project-name> [--display-name <name>] [--description <text>]
  agent-hub projects create <project-name> [--display-name <name>] [--description <text>]
  agent-hub projects rotate-key <project-id>
  agent-hub scheduler status [--agent-id <id>] [--project <project-id>]
  agent-hub executors list [--project <project-id>]
  agent-hub alerts list [--limit 20] [--include-acknowledged]
  agent-hub alerts acknowledge <alert-id> [--by <actor>]
  agent-hub agents list [--status online] [--type cron_task] [--archived active|include|only]
  agent-hub agents get <agent-id> [--include-archived]
  agent-hub agents create <agent-name> --display-name <name> [--type cron_task] [--cron <expr>] [--handler <name>] [--disabled]
  agent-hub agents update <agent-id> [--display-name <name>] [--cron <expr>|--clear-cron] [--handler <name>|--clear-handler]
  agent-hub agents schedule-preview <agent-id> [--limit 5]
  agent-hub agents enable <agent-id>
  agent-hub agents disable <agent-id>
  agent-hub agents drain <agent-id> [--cancel-running]
  agent-hub agents delete <agent-id>
  agent-hub executions list [--agent-id <id>] [--status queued] [--trigger-type api] [--limit 50] [--offset 0]
  agent-hub executions get <execution-id>
  agent-hub executions wait <execution-id> [--timeout-ms 600000] [--interval-ms 1000] [--require-success]
  agent-hub executions cancel <execution-id>
  agent-hub executions rerun <execution-id>
  agent-hub traces list <execution-id>
  agent-hub trigger <agent-name> [--payload '{"key":"value"}'] [--idempotency-key <key>] [--dedup-policy skip_if_running]

Connection:
  --url <url>                         Defaults to AGENT_HUB_URL or ${DEFAULT_URL}
  --api-key <key>                     Defaults to AGENT_HUB_API_KEY or ${DEFAULT_API_KEY}
  --dashboard-user <user>             Defaults to AGENT_HUB_DASHBOARD_USER or ${DEFAULT_DASHBOARD_USER}
  --dashboard-password <password>     Defaults to AGENT_HUB_DASHBOARD_PASSWORD or ${DEFAULT_DASHBOARD_PASSWORD}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
