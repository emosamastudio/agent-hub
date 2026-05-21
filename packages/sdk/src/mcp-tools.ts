import { z } from "zod";
import {
  type AgentHubControlClient,
  type AgentHubAcknowledgeAlertOptions,
  type AgentHubArchiveFilter,
  type AgentHubAgentTargetOptions,
  type AgentHubCreateAgentInput,
  type AgentHubCreateProjectInput,
  type AgentHubDedupPolicy,
  type AgentHubDoctorOptions,
  type AgentHubDrainAgentOptions,
  type AgentHubDrainProjectOptions,
  type AgentHubListAgentsQuery,
  type AgentHubListAlertsQuery,
  type AgentHubListExecutionsQuery,
  type AgentHubListExecutorsQuery,
  type AgentHubOpsStatusOptions,
  type AgentHubRunCanaryOptions,
  type AgentHubSchedulePreviewOptions,
  type AgentHubSchedulerStatusQuery,
  type AgentHubUpdateAgentInput,
  type AgentHubWaitExecutionOptions,
} from "./index.js";

export interface AgentHubMcpTextResult {
  content: Array<{ type: "text"; text: string }>;
}

export interface AgentHubMcpTool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: TArgs) => Promise<AgentHubMcpTextResult>;
}

export function createAgentHubMcpTools(client: AgentHubControlClient): AgentHubMcpTool[] {
  return [
    {
      name: "agent_hub_health",
      description: "Check Agent Hub server health.",
      inputSchema: {},
      handler: async () => toMcpText(await client.health()),
    },
    {
      name: "agent_hub_ready",
      description: "Check whether Agent Hub is ready to serve traffic, including database readiness.",
      inputSchema: {},
      handler: async () => toMcpText(await client.ready()),
    },
    {
      name: "agent_hub_get_metrics",
      description: "Read Agent Hub operational counters and scheduler runtime metrics for canary observation.",
      inputSchema: {},
      handler: async () => toMcpText(await client.getMetrics()),
    },
    {
      name: "agent_hub_doctor",
      description: "Run Agent Hub diagnostics across health, readiness, metrics, projects, agents, executors, and alerts.",
      inputSchema: {
        project: z.string().optional(),
      },
      handler: async (args) => toMcpText(await client.doctor(compact({
        project: stringArg(args.project),
      }) as AgentHubDoctorOptions)),
    },
    {
      name: "agent_hub_get_ops_status",
      description: "Read a project-scoped operational status snapshot for agent-driven deployment checks and observation.",
      inputSchema: {
        project: z.string().optional(),
        alertLimit: z.number().int().min(1).optional(),
        executionLimit: z.number().int().min(1).optional(),
        failOnWarning: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.getOpsStatus(compactDefined({
        project: stringArg(args.project),
        alertLimit: numberArg(args.alertLimit),
        executionLimit: numberArg(args.executionLimit),
        failOnWarning: booleanArg(args.failOnWarning),
      }) as AgentHubOpsStatusOptions)),
    },
    {
      name: "agent_hub_list_projects",
      description: "List Agent Hub projects without exposing API key hashes or plaintext keys.",
      inputSchema: {},
      handler: async () => toMcpText(await client.listProjects()),
    },
    {
      name: "agent_hub_ensure_project",
      description: "Return an existing project by name, or create it and return the one-time API key if missing.",
      inputSchema: {
        name: z.string().min(1),
        displayName: z.string().optional(),
        description: z.string().optional(),
        apiKey: z.string().optional(),
      },
      handler: async (args) => toMcpText(await client.ensureProject(compactDefined({
        name: args.name as string,
        displayName: stringArg(args.displayName),
        description: stringArg(args.description),
        apiKey: stringArg(args.apiKey),
      }) as AgentHubCreateProjectInput)),
    },
    {
      name: "agent_hub_create_project",
      description: "Create a project and return the one-time project API key for executor integration.",
      inputSchema: {
        name: z.string().min(1),
        displayName: z.string().optional(),
        description: z.string().optional(),
        apiKey: z.string().optional(),
      },
      handler: async (args) => toMcpText(await client.createProject(compactDefined({
        name: args.name as string,
        displayName: stringArg(args.displayName),
        description: stringArg(args.description),
        apiKey: stringArg(args.apiKey),
      }) as AgentHubCreateProjectInput)),
    },
    {
      name: "agent_hub_rotate_project_api_key",
      description: "Rotate a project's executor API key by project name or id and return the new one-time plaintext key.",
      inputSchema: {
        project: z.string().min(1).optional(),
        projectId: z.string().min(1).optional(),
      },
      handler: async (args) => {
        const project = stringArg(args.project) ?? stringArg(args.projectId);
        if (!project) throw new Error("project is required");
        return toMcpText(await client.rotateProjectApiKey(project));
      },
    },
    {
      name: "agent_hub_drain_project",
      description: "Disable every agent in a project and cancel queued executions; optionally cancel running executions too.",
      inputSchema: {
        project: z.string().min(1),
        cancelRunning: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.drainProject(args.project as string, compactDefined({
        cancelRunning: booleanArg(args.cancelRunning),
      }) as AgentHubDrainProjectOptions)),
    },
    {
      name: "agent_hub_set_project_enabled",
      description: "Enable or disable every active agent in a project by project name or id.",
      inputSchema: {
        project: z.string().min(1),
        enabled: z.boolean(),
      },
      handler: async (args) => toMcpText(await client.setProjectEnabled(args.project as string, args.enabled as boolean)),
    },
    {
      name: "agent_hub_get_scheduler_status",
      description: "Get scheduler diagnostics including queue depth, dispatch state, capacity, and upcoming cron timestamps. The project filter accepts a project name or id.",
      inputSchema: {
        project: z.string().optional(),
        agentId: z.string().optional(),
      },
      handler: async (args) => toMcpText(await client.getSchedulerStatus(compact({
        project: stringArg(args.project),
        agent_id: stringArg(args.agentId),
      }) as AgentHubSchedulerStatusQuery)),
    },
    {
      name: "agent_hub_list_executors",
      description: "List online executor heartbeats and active execution counts for a project name or id.",
      inputSchema: {
        project: z.string().optional(),
      },
      handler: async (args) => toMcpText(await client.listExecutors(compact({
        project: stringArg(args.project),
      }) as AgentHubListExecutorsQuery)),
    },
    {
      name: "agent_hub_list_alerts",
      description: "List active scheduler alerts, optionally including acknowledged alert history.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        includeAcknowledged: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.listAlerts(compactDefined({
        limit: numberArg(args.limit),
        includeAcknowledged: booleanArg(args.includeAcknowledged),
      }) as AgentHubListAlertsQuery)),
    },
    {
      name: "agent_hub_acknowledge_alert",
      description: "Acknowledge an alert after an operator or agent has handled it.",
      inputSchema: {
        alertId: z.number().int().min(1),
        acknowledgedBy: z.string().optional(),
      },
      handler: async (args) => toMcpText(await client.acknowledgeAlert(args.alertId as number, compactDefined({
        acknowledgedBy: stringArg(args.acknowledgedBy),
      }) as AgentHubAcknowledgeAlertOptions)),
    },
    {
      name: "agent_hub_list_agents",
      description: "List registered agents and their current executor status. The project filter accepts a project name or id.",
      inputSchema: {
        project: z.string().optional(),
        type: z.string().optional(),
        status: z.string().optional(),
        archived: z.enum(["active", "include", "only"]).optional(),
      },
      handler: async (args) => toMcpText(await client.listAgents(compact({
        project: stringArg(args.project),
        type: stringArg(args.type),
        status: stringArg(args.status),
        archived: archiveFilterArg(args.archived),
      }) as AgentHubListAgentsQuery)),
    },
    {
      name: "agent_hub_get_agent",
      description: "Get one agent by id or by name with an optional project selector.",
      inputSchema: {
        agentId: z.string().min(1),
        project: z.string().optional(),
        includeArchived: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.getAgent(args.agentId as string, compactDefined({
        project: stringArg(args.project),
        includeArchived: booleanArg(args.includeArchived),
      }))),
    },
    {
      name: "agent_hub_create_agent",
      description: "Create or upsert a dashboard-managed agent schedule.",
      inputSchema: {
        projectId: z.string().optional(),
        name: z.string().min(1),
        displayName: z.string().min(1),
        description: z.string().min(10),
        agentType: z.enum(["cron_task", "llm_agent"]).optional(),
        cronExpression: z.string().nullable().optional(),
        handlerName: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
        misfirePolicy: z.enum(["fire_once", "fire_all", "drop"]).optional(),
        concurrency: z.number().int().min(1).optional(),
        maxPendingQueue: z.number().int().min(0).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        retryMax: z.number().int().min(0).optional(),
        retryBackoffBaseMs: z.number().int().min(0).optional(),
        maxTurns: z.number().int().min(0).nullable().optional(),
        maxCostUsd: z.number().min(0).nullable().optional(),
        inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
        allowTriggerBy: z.record(z.string(), z.unknown()).nullable().optional(),
        idempotencyWindowSeconds: z.number().int().min(1).optional(),
        labels: z.record(z.string(), z.string()).optional(),
      },
      handler: async (args) => toMcpText(await client.createAgent(compactDefined({
        projectId: stringArg(args.projectId),
        name: args.name as string,
        displayName: args.displayName as string,
        description: args.description as string,
        agentType: agentTypeArg(args.agentType),
        cronExpression: nullableStringArg(args.cronExpression),
        handlerName: nullableStringArg(args.handlerName),
        enabled: booleanArg(args.enabled),
        misfirePolicy: misfirePolicyArg(args.misfirePolicy),
        concurrency: numberArg(args.concurrency),
        maxPendingQueue: numberArg(args.maxPendingQueue),
        timeoutSeconds: numberArg(args.timeoutSeconds),
        retryMax: numberArg(args.retryMax),
        retryBackoffBaseMs: numberArg(args.retryBackoffBaseMs),
        maxTurns: nullableNumberArg(args.maxTurns),
        maxCostUsd: nullableNumberArg(args.maxCostUsd),
        inputSchema: recordOrNullArg(args.inputSchema),
        allowTriggerBy: recordOrNullArg(args.allowTriggerBy),
        idempotencyWindowSeconds: numberArg(args.idempotencyWindowSeconds),
        labels: stringRecordArg(args.labels),
      }) as AgentHubCreateAgentInput)),
    },
    {
      name: "agent_hub_update_agent",
      description: "Update dashboard-managed agent schedule and execution settings by id or by name with an optional project selector.",
      inputSchema: {
        agentId: z.string().min(1),
        project: z.string().optional(),
        displayName: z.string().optional(),
        description: z.string().nullable().optional(),
        cronExpression: z.string().nullable().optional(),
        handlerName: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
        misfirePolicy: z.enum(["fire_once", "fire_all", "drop"]).optional(),
        concurrency: z.number().int().min(1).optional(),
        maxPendingQueue: z.number().int().min(0).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        retryMax: z.number().int().min(0).optional(),
        retryBackoffBaseMs: z.number().int().min(0).optional(),
        maxTurns: z.number().int().min(0).nullable().optional(),
        maxCostUsd: z.number().min(0).nullable().optional(),
        executorHost: z.string().nullable().optional(),
        inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
        allowTriggerBy: z.record(z.string(), z.unknown()).nullable().optional(),
        idempotencyWindowSeconds: z.number().int().min(1).optional(),
        labels: z.record(z.string(), z.string()).optional(),
      },
      handler: async (args) => {
        const patch = compactDefined({
          displayName: stringArg(args.displayName),
          description: nullableStringArg(args.description),
          cronExpression: nullableStringArg(args.cronExpression),
          handlerName: nullableStringArg(args.handlerName),
          enabled: booleanArg(args.enabled),
          misfirePolicy: misfirePolicyArg(args.misfirePolicy),
          concurrency: numberArg(args.concurrency),
          maxPendingQueue: numberArg(args.maxPendingQueue),
          timeoutSeconds: numberArg(args.timeoutSeconds),
          retryMax: numberArg(args.retryMax),
          retryBackoffBaseMs: numberArg(args.retryBackoffBaseMs),
          maxTurns: nullableNumberArg(args.maxTurns),
          maxCostUsd: nullableNumberArg(args.maxCostUsd),
          executorHost: nullableStringArg(args.executorHost),
          inputSchema: recordOrNullArg(args.inputSchema),
          allowTriggerBy: recordOrNullArg(args.allowTriggerBy),
          idempotencyWindowSeconds: numberArg(args.idempotencyWindowSeconds),
          labels: stringRecordArg(args.labels),
        }) as AgentHubUpdateAgentInput;
        const options = agentTargetOptions(args);
        return toMcpText(
          hasKeys(options)
            ? await client.updateAgent(args.agentId as string, patch, options)
            : await client.updateAgent(args.agentId as string, patch),
        );
      },
    },
    {
      name: "agent_hub_preview_agent_schedule",
      description: "Preview future cron run timestamps for one agent by id or by name with an optional project selector.",
      inputSchema: {
        agentId: z.string().min(1),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      handler: async (args) => toMcpText(await client.getAgentSchedulePreview(args.agentId as string, compactDefined({
        limit: numberArg(args.limit),
        project: stringArg(args.project),
      }) as AgentHubSchedulePreviewOptions)),
    },
    {
      name: "agent_hub_delete_agent",
      description: "Archive a dashboard-managed agent by id or by name with an optional project selector after active work has drained.",
      inputSchema: {
        agentId: z.string().min(1),
        project: z.string().optional(),
      },
      handler: async (args) => {
        const options = agentTargetOptions(args);
        if (hasKeys(options)) {
          await client.deleteAgent(args.agentId as string, options);
        } else {
          await client.deleteAgent(args.agentId as string);
        }
        return toMcpText({ ok: true });
      },
    },
    {
      name: "agent_hub_drain_agent",
      description: "Disable an agent by id or by name with an optional project selector and cancel queued executions before deletion; optionally cancel running executions too.",
      inputSchema: {
        agentId: z.string().min(1),
        project: z.string().optional(),
        cancelRunning: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.drainAgent(args.agentId as string, compactDefined({
        cancelRunning: booleanArg(args.cancelRunning),
        project: stringArg(args.project),
      }) as AgentHubDrainAgentOptions)),
    },
    {
      name: "agent_hub_list_executions",
      description: "List executions with optional project, agent, status, trigger, and pagination filters.",
      inputSchema: {
        project: z.string().optional(),
        agent: z.string().optional(),
        agentId: z.string().optional(),
        status: z.string().optional(),
        triggerType: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(),
      },
      handler: async (args) => toMcpText(await client.listExecutions(compact({
        project: stringArg(args.project),
        agent: stringArg(args.agent),
        agent_id: stringArg(args.agentId),
        status: stringArg(args.status),
        trigger_type: stringArg(args.triggerType),
        since: stringArg(args.since),
        limit: numberArg(args.limit),
        offset: numberArg(args.offset),
      }) as AgentHubListExecutionsQuery)),
    },
    {
      name: "agent_hub_get_execution",
      description: "Get one execution by id.",
      inputSchema: {
        executionId: z.string().min(1),
      },
      handler: async (args) => toMcpText(await client.getExecution(args.executionId as string)),
    },
    {
      name: "agent_hub_inspect_execution",
      description: "Get an execution diagnostic bundle with detail, trace spans, and trigger-chain context.",
      inputSchema: {
        executionId: z.string().min(1),
      },
      handler: async (args) => toMcpText(await client.inspectExecution(args.executionId as string)),
    },
    {
      name: "agent_hub_wait_execution",
      description: "Poll one execution until it reaches success, failed, timeout, or cancelled.",
      inputSchema: {
        executionId: z.string().min(1),
        timeoutMs: z.number().int().min(0).optional(),
        intervalMs: z.number().int().min(0).optional(),
        requireSuccess: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.waitForExecution(args.executionId as string, compactDefined({
        timeoutMs: numberArg(args.timeoutMs),
        intervalMs: numberArg(args.intervalMs),
        requireSuccess: booleanArg(args.requireSuccess),
      }) as AgentHubWaitExecutionOptions)),
    },
    {
      name: "agent_hub_list_traces",
      description: "List trace spans recorded for an execution.",
      inputSchema: {
        executionId: z.string().min(1),
      },
      handler: async (args) => toMcpText(await client.getExecutionTraces(args.executionId as string)),
    },
    {
      name: "agent_hub_trigger_agent",
      description: "Trigger an agent with an optional JSON payload and idempotency controls.",
      inputSchema: {
        agentName: z.string().min(1),
        payload: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: z.string().optional(),
        dedupPolicy: z.enum(["skip_if_running", "skip_if_exists", "allow_duplicate"]).optional(),
      },
      handler: async (args) => toMcpText(await client.triggerAgent(args.agentName as string, {
        payload: recordArg(args.payload),
        idempotencyKey: stringArg(args.idempotencyKey),
        dedupPolicy: dedupPolicyArg(args.dedupPolicy),
      })),
    },
    {
      name: "agent_hub_trigger_and_wait_agent",
      description: "Trigger an agent and poll the created execution until it reaches a terminal status.",
      inputSchema: {
        agentName: z.string().min(1),
        payload: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: z.string().optional(),
        dedupPolicy: z.enum(["skip_if_running", "skip_if_exists", "allow_duplicate"]).optional(),
        timeoutMs: z.number().int().min(0).optional(),
        intervalMs: z.number().int().min(0).optional(),
        requireSuccess: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.triggerAgentAndWait(args.agentName as string, {
        payload: recordArg(args.payload),
        idempotencyKey: stringArg(args.idempotencyKey),
        dedupPolicy: dedupPolicyArg(args.dedupPolicy),
      }, compactDefined({
        timeoutMs: numberArg(args.timeoutMs),
        intervalMs: numberArg(args.intervalMs),
        requireSuccess: booleanArg(args.requireSuccess),
      }) as AgentHubWaitExecutionOptions)),
    },
    {
      name: "agent_hub_run_canary",
      description: "Run a canary by checking diagnostics, triggering an agent, waiting for success, and checking diagnostics again.",
      inputSchema: {
        agentName: z.string().min(1),
        project: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: z.string().optional(),
        dedupPolicy: z.enum(["skip_if_running", "skip_if_exists", "allow_duplicate"]).optional(),
        timeoutMs: z.number().int().min(0).optional(),
        intervalMs: z.number().int().min(0).optional(),
        requireSuccess: z.boolean().optional(),
      },
      handler: async (args) => toMcpText(await client.runCanary(args.agentName as string, compactDefined({
        project: stringArg(args.project),
        payload: recordArg(args.payload),
        idempotencyKey: stringArg(args.idempotencyKey),
        dedupPolicy: dedupPolicyArg(args.dedupPolicy),
        timeoutMs: numberArg(args.timeoutMs),
        intervalMs: numberArg(args.intervalMs),
        requireSuccess: booleanArg(args.requireSuccess),
      }) as AgentHubRunCanaryOptions)),
    },
    {
      name: "agent_hub_set_agent_enabled",
      description: "Enable or disable an agent by id or by name with an optional project selector.",
      inputSchema: {
        agentId: z.string().min(1),
        project: z.string().optional(),
        enabled: z.boolean(),
      },
      handler: async (args) => {
        const options = agentTargetOptions(args);
        return toMcpText(
          hasKeys(options)
            ? await client.setAgentEnabled(args.agentId as string, args.enabled as boolean, options)
            : await client.setAgentEnabled(args.agentId as string, args.enabled as boolean),
        );
      },
    },
    {
      name: "agent_hub_cancel_execution",
      description: "Cancel a queued or running execution by id.",
      inputSchema: {
        executionId: z.string().min(1),
      },
      handler: async (args) => toMcpText(await client.cancelExecution(args.executionId as string)),
    },
    {
      name: "agent_hub_rerun_execution",
      description: "Create a queued rerun using the original execution payload.",
      inputSchema: {
        executionId: z.string().min(1),
      },
      handler: async (args) => toMcpText(await client.rerunExecution(args.executionId as string)),
    },
  ];
}

function toMcpText(value: unknown): AgentHubMcpTextResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value) as Array<[keyof T, unknown]>) {
    if (entry !== undefined && entry !== null && entry !== "") {
      result[key] = entry as T[keyof T];
    }
  }
  return result;
}

function compactDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value) as Array<[keyof T, unknown]>) {
    if (entry !== undefined) {
      result[key] = entry as T[keyof T];
    }
  }
  return result;
}

function agentTargetOptions(args: Record<string, unknown>): AgentHubAgentTargetOptions {
  return compactDefined({
    project: stringArg(args.project),
  }) as AgentHubAgentTargetOptions;
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableStringArg(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringArg(value);
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumberArg(value: unknown): number | null | undefined {
  if (value === null) return null;
  return numberArg(value);
}

function booleanArg(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordArg(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordOrNullArg(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  return recordArg(value);
}

function stringRecordArg(value: unknown): Record<string, string> | undefined {
  const record = recordArg(value);
  if (!record) return undefined;
  for (const entry of Object.values(record)) {
    if (typeof entry !== "string") return undefined;
  }
  return record as Record<string, string>;
}

function agentTypeArg(value: unknown): "cron_task" | "llm_agent" | undefined {
  return value === "cron_task" || value === "llm_agent" ? value : undefined;
}

function misfirePolicyArg(value: unknown): "fire_once" | "fire_all" | "drop" | undefined {
  return value === "fire_once" || value === "fire_all" || value === "drop" ? value : undefined;
}

function archiveFilterArg(value: unknown): AgentHubArchiveFilter | undefined {
  return value === "active" || value === "include" || value === "only" ? value : undefined;
}

function dedupPolicyArg(value: unknown): AgentHubDedupPolicy | undefined {
  return value === "skip_if_running" || value === "skip_if_exists" || value === "allow_duplicate"
    ? value
    : undefined;
}
