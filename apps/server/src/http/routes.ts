import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { serverConfig } from "../config.js";
import { Cron } from "croner";
import { getBearerToken, isValidDashboardBasicAuth } from "../middleware/auth.js";
import { hashApiKey } from "../security.js";
import { getSchedulerRuntimeStats } from "../services/scheduler.js";
import { createLlmProxyHandler } from "./llm-proxy.js";

interface ExtendedAppContext extends AppContext {}

const supportedAgentHubVersion = "1";
const terminalExecutionStatuses = new Set(["success", "failed", "timeout", "cancelled"]);
const agentArchiveFilters = new Set(["active", "include", "only"]);
type AgentArchiveFilter = "active" | "include" | "only";

function isTerminalExecutionStatus(status: string) {
  return terminalExecutionStatuses.has(status);
}

function durationSince(startedAt: Date | string | null | undefined) {
  if (!startedAt) return null;
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedMs)) return null;
  return Math.max(Date.now() - startedMs, 0);
}

function parseAgentArchiveFilter(value: unknown): AgentArchiveFilter | null {
  if (value === undefined || value === null || value === "") return "active";
  if (typeof value === "string" && agentArchiveFilters.has(value)) {
    return value as AgentArchiveFilter;
  }
  return null;
}

function queryFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function validationErrorPayload(error: z.ZodError, code: string) {
  const details = error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return {
    error: code,
    message: details[0]?.message ?? code,
    details,
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function generateProjectApiKey() {
  return `agh_${randomBytes(24).toString("base64url")}`;
}

function serializeProject(project: Record<string, any>) {
  const { apiKeyHash, dashboardPasswordHash, ...safeProject } = project;
  return safeProject;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function cronDiagnostic(cronExpression: string | null, lastExecutionAt: Date | string | null | undefined) {
  if (!cronExpression) {
    return { nextRunAt: null, dueRunAt: null, cronError: null };
  }
  try {
    const cron = new Cron(cronExpression);
    const now = new Date();
    const nextRunAt = cron.nextRun(now);
    const dueCursor = lastExecutionAt ? new Date(lastExecutionAt) : new Date(0);
    const dueRunAt = cron.nextRun(dueCursor);
    return {
      nextRunAt: iso(nextRunAt),
      dueRunAt: dueRunAt && dueRunAt <= now ? dueRunAt.toISOString() : null,
      cronError: null,
    };
  } catch (error) {
    return {
      nextRunAt: null,
      dueRunAt: null,
      cronError: error instanceof Error ? error.message : "invalid cron expression",
    };
  }
}

function dispatchStateFor(agent: { enabled: boolean; archivedAt?: Date | string | null; executorStatus: string }, queuedCount: number, capacityAvailable: number) {
  if (agent.archivedAt) return "archived";
  if (!agent.enabled) return "disabled";
  if (agent.executorStatus !== "online") return "executor_offline";
  if (capacityAvailable <= 0) return "concurrency_full";
  return queuedCount > 0 ? "dispatchable" : "idle";
}

function scheduleStateFor(
  agent: { enabled: boolean; archivedAt?: Date | string | null; cronExpression: string | null },
  pendingCount: number,
  maxPendingQueue: number,
  dueRunAt: string | null,
  cronError: string | null,
) {
  if (agent.archivedAt) return "archived";
  if (!agent.enabled) return "disabled";
  if (!agent.cronExpression) return "manual_only";
  if (cronError) return "invalid_cron";
  if (pendingCount >= maxPendingQueue) return "queue_full";
  return dueRunAt ? "due" : "scheduled";
}

async function healthPayload(ctx: ExtendedAppContext) {
  await ctx.db.execute(sql`SELECT 1`);
  return {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {
      database: {
        status: "ok",
      },
    },
  };
}

function healthErrorPayload(error: unknown) {
  return {
    status: "error",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {
      database: {
        status: "error",
        message: error instanceof Error ? error.message : "database check failed",
      },
    },
  };
}

const agentSpecSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().trim()
    .min(10, "description must be at least 10 characters")
    .max(1000, "description must be at most 1000 characters"),
  agentType: z.enum(["cron_task", "llm_agent"]),
  cron: z.string().optional(),
  handler: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  concurrency: z.number().int().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
  retryMax: z.number().int().min(0).optional(),
  retryBackoffBaseMs: z.number().int().optional(),
  maxPendingQueue: z.number().int().optional(),
  misfirePolicy: z.enum(["fire_once", "fire_all", "drop"]).optional(),
  maxTurns: z.number().int().optional(),
  maxCostUsd: z.number().optional(),
  executorHost: z.string().optional(),
  allowTriggerBy: z.record(z.string(), z.unknown()).nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

const agentPatchSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  cronExpression: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  misfirePolicy: z.enum(["fire_once", "fire_all", "drop"]).optional(),
  concurrency: z.number().int().min(1).optional(),
  maxPendingQueue: z.number().int().min(0).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
  retryMax: z.number().int().min(0).optional(),
  retryBackoffBaseMs: z.number().int().min(0).optional(),
  maxTurns: z.number().int().min(0).nullable().optional(),
  maxCostUsd: z.number().min(0).nullable().optional(),
  handlerName: z.string().nullable().optional(),
  executorHost: z.string().nullable().optional(),
  executorStatus: z.enum(["online", "offline"]).optional(),
  inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  allowTriggerBy: z.record(z.string(), z.unknown()).nullable().optional(),
  idempotencyWindowSeconds: z.number().int().min(1).optional(),
  labels: z.record(z.string(), z.string()).optional(),
}).strict().refine((body) => Object.keys(body).length > 0);

const dashboardAgentCreateSchema = z.object({
  projectId: z.string().uuid().optional(),
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().trim()
    .min(10, "description must be at least 10 characters")
    .max(1000, "description must be at most 1000 characters"),
  agentType: z.enum(["cron_task", "llm_agent"]).default("cron_task"),
  cronExpression: z.string().min(1).nullable().optional(),
  handlerName: z.string().min(1).nullable().optional(),
  enabled: z.boolean().default(true),
  misfirePolicy: z.enum(["fire_once", "fire_all", "drop"]).default("fire_once"),
  concurrency: z.number().int().min(1).default(1),
  maxPendingQueue: z.number().int().min(0).default(100),
  timeoutSeconds: z.number().int().min(1).default(600),
  retryMax: z.number().int().min(0).default(3),
  retryBackoffBaseMs: z.number().int().min(0).default(30000),
  maxTurns: z.number().int().min(0).nullable().optional(),
  maxCostUsd: z.number().min(0).nullable().optional(),
  inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  allowTriggerBy: z.record(z.string(), z.unknown()).nullable().optional(),
  idempotencyWindowSeconds: z.number().int().min(1).default(3600),
  labels: z.record(z.string(), z.string()).optional(),
}).strict();

const bulkAgentPatchSchema = z.object({
  project: z.string().uuid(),
  enabled: z.boolean(),
}).strict();

const projectCreateSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  displayName: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  apiKey: z.string().min(16).optional(),
}).strict();

const triggerSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().optional(),
  dedup_policy: z.enum(["skip_if_running", "skip_if_exists", "allow_duplicate"]).default("skip_if_running"),
});

const heartbeatSchema = z.object({
  agent_names: z.array(z.string().min(1)).min(1).optional(),
  executions: z.array(z.object({
    execution_id: z.string(),
    progress_percent: z.number().int().min(0).max(100).optional(),
    progress_message: z.string().optional(),
  })).optional(),
});

const reportSchema = z.object({
  status: z.enum(["success", "failed"]),
  result_summary: z.string().optional(),
  result_data: z.record(z.string(), z.unknown()).optional(),
  error_message: z.string().optional(),
  error_stack: z.string().optional(),
  trace_count_expected: z.number().int().optional(),
});

const traceBatchSchema = z.object({
  traces: z.array(z.object({
    turn_index: z.number().int(),
    span_index: z.number().int().optional(),
    parent_span_id: z.string().optional(),
    role: z.enum(["system", "user", "assistant", "tool"]),
    span_type: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    input_content: z.string().optional(),
    output_content: z.string().optional(),
    tool_calls: z.unknown().optional(),
    tool_results: z.unknown().optional(),
    input_tokens: z.number().int().optional(),
    output_tokens: z.number().int().optional(),
    cost_estimate: z.number().optional(),
    latency_ms: z.number().int().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })),
});

const schedulePreviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const alertsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  include_acknowledged: z.preprocess((value) => value === true || value === "true", z.boolean()).default(false),
});

const alertAcknowledgeSchema = z.object({
  acknowledgedBy: z.string().min(1).max(100).optional(),
}).strict();

const agentDrainSchema = z.object({
  cancel_running: z.boolean().default(false),
}).strict();

const projectDrainSchema = z.object({
  cancel_running: z.boolean().default(false),
}).strict();


export function registerRoutes(app: FastifyInstance, ctx: ExtendedAppContext) {
  // ── Health ──
  let cachedProjectId: string | null = null;

  app.addHook("onRequest", (_request, reply, done) => {
    reply.header("Agent-Hub-Version", supportedAgentHubVersion);
    done();
  });

  function rejectUnsupportedAgentHubVersion(request: FastifyRequest, reply: FastifyReply): boolean {
    const requestedVersion = firstHeaderValue(request.headers["agent-hub-version"]);
    if (!requestedVersion || requestedVersion === supportedAgentHubVersion) {
      return false;
    }
    reply.status(426).send({
      error: "unsupported_agent_hub_version",
      message: `Agent-Hub-Version ${requestedVersion} is not supported`,
      requested_version: requestedVersion,
      supported_versions: [supportedAgentHubVersion],
    });
    return true;
  }

  async function getDefaultProjectId(): Promise<string> {
    if (cachedProjectId) return cachedProjectId;
    const project = await ctx.projectRepo.findByName("default");
    if (!project) throw new Error("Default project not found — run seed first");
    cachedProjectId = project.id;
    return cachedProjectId;
  }

  async function requireProjectFromApiKey(request: FastifyRequest, reply: FastifyReply) {
    if (rejectUnsupportedAgentHubVersion(request, reply)) return null;
    const token = getBearerToken(request);
    if (!token) {
      reply.status(401).send({ error: "api_key_required" });
      return null;
    }

    let project = await ctx.projectRepo.findByApiKeyHash(hashApiKey(token));
    if (!project && token === serverConfig.defaultProjectApiKey) {
      project = await ctx.projectRepo.findByName("default");
    }

    if (!project || project.status !== "active") {
      reply.status(401).send({ error: "invalid_api_key" });
      return null;
    }
    return project;
  }

  async function resolveWriteProject(request: FastifyRequest, reply: FastifyReply, allowDashboard = false) {
    if (allowDashboard && isValidDashboardBasicAuth(request)) {
      const project = await ctx.projectRepo.findByName("default");
      if (!project) {
        reply.status(500).send({ error: "default_project_missing" });
        return null;
      }
      return project;
    }
    return requireProjectFromApiKey(request, reply);
  }

  function getAgentNamesFromQuery(request: FastifyRequest): string[] {
    const query = request.query as Record<string, string | undefined>;
    const raw = query.agent_names ?? query.agents;
    if (!raw) return [];
    return raw.split(",").map((name) => name.trim()).filter(Boolean);
  }

  async function getExecutionAndAgent(id: string) {
    const execution = await ctx.executionRepo.findById(id);
    if (!execution) return null;
    const agent = await ctx.agentRepo.findById(execution.agentId);
    if (!agent) return null;
    return { execution, agent };
  }

  const wsClients = new Set<any>();

  function broadcast(event: Record<string, unknown>) {
    const msg = JSON.stringify(event);
    for (const socket of wsClients) {
      try { socket.send(msg); } catch {}
    }
  }
  (globalThis as any).__hubBroadcast = broadcast;

  app.get("/api/health", async (_request, reply) => {
    try {
      return await healthPayload(ctx);
    } catch (error) {
      return reply.status(503).send(healthErrorPayload(error));
    }
  });

  app.get("/api/ready", async (_request, reply) => {
    try {
      return await healthPayload(ctx);
    } catch (error) {
      return reply.status(503).send(healthErrorPayload(error));
    }
  });

  // ── Metrics ──
  app.get("/api/metrics", async () => {
    const [agents, executionCounts, alertsActive] = await Promise.all([
      ctx.agentRepo.findAll({}),
      ctx.executionRepo.countByStatus(),
      ctx.alertRepo.countActive(),
    ]);
    const agentsOnline = agents.filter(a => a.executorStatus === "online").length;
    const agentsEnabled = agents.filter(a => a.enabled).length;
    return {
      agents_total: agents.length,
      agents_enabled: agentsEnabled,
      agents_disabled: agents.length - agentsEnabled,
      agents_online: agentsOnline,
      agents_offline: agents.length - agentsOnline,
      executions_queued: executionCounts.queued ?? 0,
      executions_running: executionCounts.running ?? 0,
      executions_success: executionCounts.success ?? 0,
      executions_failed: executionCounts.failed ?? 0,
      executions_timeout: executionCounts.timeout ?? 0,
      executions_cancelled: executionCounts.cancelled ?? 0,
      executions_terminal: (executionCounts.success ?? 0)
        + (executionCounts.failed ?? 0)
        + (executionCounts.timeout ?? 0)
        + (executionCounts.cancelled ?? 0),
      alerts_active: alertsActive,
      scheduler: getSchedulerRuntimeStats(),
    };
  });

  app.get("/api/scheduler/status", async (request) => {
    const { project, agent_id } = request.query as Record<string, string | undefined>;
    const activeAgents = await ctx.agentRepo.findAll({ projectId: project });
    const selectedAgents = agent_id
      ? activeAgents.filter((agent) => agent.id === agent_id)
      : activeAgents;

    const agentStatuses = await Promise.all(selectedAgents.map(async (agent) => {
      const [queuedCount, runningCount] = await Promise.all([
        ctx.executionRepo.countByAgentAndStatus(agent.id, ["queued"]),
        ctx.executionRepo.countByAgentAndStatus(agent.id, ["running"]),
      ]);
      const pendingCount = queuedCount + runningCount;
      const capacityAvailable = Math.max(agent.concurrency - agent.activeExecutionCount, 0);
      const queueAvailable = Math.max(agent.maxPendingQueue - pendingCount, 0);
      const cron = cronDiagnostic(agent.cronExpression, agent.lastExecutionAt);

      return {
        id: agent.id,
        projectId: agent.projectId,
        name: agent.name,
        displayName: agent.displayName,
        agentType: agent.agentType,
        enabled: agent.enabled,
        executorStatus: agent.executorStatus,
        cronExpression: agent.cronExpression,
        misfirePolicy: agent.misfirePolicy,
        lastExecutionAt: iso(agent.lastExecutionAt),
        lastHeartbeatAt: iso(agent.lastHeartbeatAt),
        nextRunAt: cron.nextRunAt,
        dueRunAt: cron.dueRunAt,
        cronError: cron.cronError,
        queuedCount,
        runningCount,
        pendingCount,
        activeExecutionCount: agent.activeExecutionCount,
        concurrency: agent.concurrency,
        capacityAvailable,
        maxPendingQueue: agent.maxPendingQueue,
        queueAvailable,
        dispatchState: dispatchStateFor(agent, queuedCount, capacityAvailable),
        scheduleState: scheduleStateFor(
          agent,
          pendingCount,
          agent.maxPendingQueue,
          cron.dueRunAt,
          cron.cronError,
        ),
      };
    }));

    return {
      generatedAt: new Date().toISOString(),
      scheduler: {
        tickMs: serverConfig.schedulerTickMs,
        executionRetentionDays: serverConfig.executionRetentionDays,
        traceRetentionDays: serverConfig.traceRetentionDays,
      },
      agents: agentStatuses,
    };
  });

  // ── Agent Registry ──
  app.put("/api/registry/agents", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const parsed = agentSpecSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(validationErrorPayload(parsed.error, "invalid_agent_spec"));
    }
    const body = parsed.data;
    if (body.cron) {
      try { new Cron(body.cron); } catch {
        return reply.status(400).send({ error: "invalid_cron_expression" });
      }
    }
    const agent = await ctx.agentRepo.upsert(project.id, body.name, {
      displayName: body.displayName,
      description: body.description,
      agentType: body.agentType,
      cronExpression: body.cron ?? null,
      handlerName: body.handler ?? null,
      inputSchema: body.inputSchema as any,
      concurrency: body.concurrency ?? 1,
      timeoutSeconds: body.timeoutSeconds ?? 600,
      retryMax: body.retryMax ?? 3,
      retryBackoffBaseMs: body.retryBackoffBaseMs ?? 30000,
      maxPendingQueue: body.maxPendingQueue ?? 100,
      misfirePolicy: body.misfirePolicy ?? "fire_once",
      maxTurns: body.maxTurns ?? null,
      maxCostUsd: body.maxCostUsd?.toString() as any ?? null,
      executorHost: body.executorHost ?? null,
      allowTriggerBy: body.allowTriggerBy as any,
      labels: body.labels as any,
      executorStatus: "online",
      lastHeartbeatAt: new Date(),
    });
    return reply.status(200).send(agent);
  });

  app.delete("/api/registry/agents/:name", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const { name } = request.params as { name: string };
    const agent = await ctx.agentRepo.findByProjectAndName(project.id, name);
    if (agent) {
      const activeExecutionCount = await ctx.executionRepo.countByAgentAndStatus(agent.id, ["queued", "running"]);
      if (activeExecutionCount > 0) {
        return reply.status(409).send({
          error: "agent_has_active_executions",
          active_execution_count: activeExecutionCount,
        });
      }
    }
    await ctx.agentRepo.deregisterByName(project.id, name);
    return reply.status(204).send();
  });

  // ── Executor Heartbeat ──
  app.post("/api/executors/heartbeat", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const body = heartbeatSchema.parse(request.body);
    if (!body.agent_names || body.agent_names.length === 0) {
      return reply.status(400).send({ error: "agent_names_required" });
    }
    const projectAgents = await ctx.agentRepo.findByProjectAndNames(project.id, body.agent_names);
    for (const agent of projectAgents) {
      if (!agent.enabled) continue;
      await ctx.agentRepo.updateHeartbeat(agent.id);
      broadcast({ type: "agent.updated", agent_id: agent.id, executor_status: "online" });
    }
    let executionsUpdated = 0;
    const cancelledExecutionIds: string[] = [];
    for (const execution of body.executions ?? []) {
      const updated = await ctx.executionRepo.recordHeartbeatProgress(
        execution.execution_id,
        project.id,
        {
          progressPercent: execution.progress_percent,
          progressMessage: execution.progress_message,
        },
      );
      if (updated) {
        executionsUpdated++;
        broadcast({ type: "execution.updated", execution: updated });
        continue;
      }

      const owned = await getExecutionAndAgent(execution.execution_id);
      if (
        owned &&
        owned.agent.projectId === project.id &&
        owned.execution.status === "cancelled"
      ) {
        cancelledExecutionIds.push(execution.execution_id);
      }
    }
    return {
      ok: true,
      executions_updated: executionsUpdated,
      cancelled_execution_ids: cancelledExecutionIds,
    };
  });

  // ── Executor Poll (long-poll with 30s timeout) ──
  app.get("/api/executors/poll", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const agentNames = getAgentNamesFromQuery(request);
    if (agentNames.length === 0) {
      return reply.status(400).send({ error: "agent_names_required" });
    }
    const projectAgents = (await ctx.agentRepo.findByProjectAndNames(project.id, agentNames))
      .filter((agent) => agent.enabled);
    const agentIds = projectAgents.map(a => a.id);
    if (agentIds.length === 0) return reply.status(204).send();

    // Poll with timeout: check every 1s for up to 30s
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const queuedExecs = await ctx.executionRepo.findQueued(agentIds);
      const match = queuedExecs.find(e => agentIds.includes(e.execution.agentId));

      if (match) {
        const claimed = await ctx.executionRepo.claimForDispatch(match.execution.id);
        if (!claimed) {
          // Raced with another poller, try again
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        // Generate proxy token for LLM trace capture
        const rawToken = `agh_proxy_${randomBytes(32).toString("base64url")}`;
        const tokenHash = hashApiKey(rawToken);
        await ctx.proxyTokenRepo.create({
          executionId: claimed.id,
          tokenHash,
          projectId: project.id,
          expiresAt: new Date(Date.now() + serverConfig.proxyTokenExpirySeconds * 1000),
        });
        (claimed as Record<string, unknown>).proxyToken = rawToken;
        return reply.send(claimed);
      }

      // No work yet — wait 1s then check again
      await new Promise(r => setTimeout(r, 1000));
    }

    // Timeout: no work available
    return reply.status(204).send();
  });

  // ── Execution Report ──
  app.post("/api/executions/:id/report", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const { id } = request.params as { id: string };
    const body = reportSchema.parse(request.body);
    const owned = await getExecutionAndAgent(id);
    if (!owned) return reply.status(404).send({ error: "execution not found" });
    if (owned.agent.projectId !== project.id) return reply.status(403).send({ error: "execution_not_owned" });
    const exec = owned.execution;
    if (exec.status !== "running") {
      return reply.status(409).send({ error: "execution_not_running", status: exec.status });
    }

    const durationMs = exec.startedAt ? Date.now() - new Date(exec.startedAt).getTime() : null;
    const traceIncomplete = body.trace_count_expected !== undefined
      && (exec.traceCountActual ?? 0) < body.trace_count_expected;

    const completed = await ctx.executionRepo.completeRunning(id, body.status, {
      finishedAt: new Date(),
      durationMs,
      resultSummary: body.result_summary ?? null,
      resultData: body.result_data as any,
      errorMessage: body.error_message ?? null,
      errorStack: body.error_stack ?? null,
      traceCountExpected: body.trace_count_expected ?? null,
      traceIncomplete,
    });
    if (!completed) {
      const latest = await ctx.executionRepo.findById(id);
      return reply.status(409).send({ error: "execution_not_running", status: latest?.status ?? "unknown" });
    }

    await ctx.agentRepo.decrementExecutionCount(exec.agentId);
    broadcast({ type: "execution.updated", execution: completed });
    return { ok: true };
  });

  // ── Trace Batch ──
  app.post("/api/executions/:id/traces", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const { id } = request.params as { id: string };
    const owned = await getExecutionAndAgent(id);
    if (!owned) return reply.status(404).send({ error: "execution not found" });
    if (owned.agent.projectId !== project.id) return reply.status(403).send({ error: "execution_not_owned" });
    const body = traceBatchSchema.parse(request.body);
    if (body.traces.length === 0) return { ok: true };

    const rows = body.traces.map(t => ({
      executionId: id, turnIndex: t.turn_index, spanIndex: t.span_index ?? 0,
      parentSpanId: t.parent_span_id ?? null, role: t.role, spanType: t.span_type ?? "llm",
      model: t.model ?? null, provider: t.provider ?? null,
      inputContent: t.input_content ?? null, outputContent: t.output_content ?? null,
      toolCalls: t.tool_calls as any, toolResults: t.tool_results as any,
      inputTokens: t.input_tokens ?? null, outputTokens: t.output_tokens ?? null,
      costEstimate: t.cost_estimate?.toString() ?? null, latencyMs: t.latency_ms ?? null,
      metadata: t.metadata as any,
    }));

    await ctx.traceRepo.insertBatch(rows as any[]);
    await ctx.executionRepo.incrementTraceCount(id, rows.length);
    broadcast({ type: "trace.appended", execution_id: id, count: rows.length });
    return { ok: true, count: rows.length };
  });

  // ── Agent Trigger ──
  app.post("/api/agents/:name/trigger", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = triggerSchema.parse(request.body);
    const project = await resolveWriteProject(request, reply, true);
    if (!project) return;
    const projectId = project.id;

    const parentExecId = request.headers["x-execution-id"] as string | undefined;
    const triggerSource = request.headers["x-trigger-source"] as string | undefined;
    let triggerType: "manual" | "api" | "agent" = triggerSource === "dashboard" ? "manual" : "api";
    let parentExecution: any = null;
    let rootExecutionId: string | null = null;
    let triggerDepth = 0;

    if (parentExecId) {
      parentExecution = await ctx.executionRepo.findById(parentExecId);
      if (!parentExecution) return reply.status(404).send({ error: "parent execution not found" });
      if (parentExecution.status !== "running") return reply.status(409).send({ error: "trigger_from_terminal_execution" });
      const parentAgent = await ctx.agentRepo.findById(parentExecution.agentId);
      if (!parentAgent || parentAgent.projectId !== projectId) {
        return reply.status(403).send({ error: "execution_not_owned" });
      }
      triggerType = "agent";
      rootExecutionId = parentExecution.rootExecutionId ?? parentExecution.id;
      triggerDepth = parentExecution.triggerDepth + 1;
    }

    if (triggerDepth >= serverConfig.maxTriggerDepth) {
      return reply.status(409).send({ error: "trigger_depth_exceeded", max_depth: serverConfig.maxTriggerDepth });
    }

    const targetAgent = await ctx.agentRepo.findByProjectAndName(projectId, name);
    if (!targetAgent) return reply.status(404).send({ error: "agent not found" });

    if (body.idempotency_key && body.dedup_policy !== "allow_duplicate") {
      const duplicate = await ctx.executionRepo.findDuplicate(
        targetAgent.id,
        body.idempotency_key,
        targetAgent.idempotencyWindowSeconds,
        body.dedup_policy === "skip_if_exists",
      );
      if (duplicate) {
        return reply.status(202).send({
          execution_id: duplicate.id,
          status: duplicate.status,
          duplicate: true,
        });
      }
    }

    const execution = await ctx.executionRepo.create({
      agentId: targetAgent.id,
      triggerType,
      triggeredBy: triggerType === "agent"
        ? `agent:${parentExecution ? (await ctx.agentRepo.findById(parentExecution.agentId))?.name ?? "unknown" : "unknown"}`
        : triggerType === "manual" ? `user:dashboard` : `api:${projectId}`,
      status: "queued",
      scheduledAt: new Date(),
      inputPayload: body.payload as any,
      parentExecutionId: parentExecId ?? null,
      rootExecutionId,
      triggerDepth,
      idempotencyKey: body.idempotency_key ?? null,
    } as any);

    broadcast({ type: "execution.created", execution });
    return reply.status(202).send({ execution_id: execution.id, status: "queued", duplicate: false });
  });

  // ── Cooldowns ──
  app.get("/api/cooldowns/:agentName/:key", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const { agentName, key } = request.params as { agentName: string; key: string };
    const agent = await ctx.agentRepo.findByProjectAndName(project.id, agentName);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const result = await ctx.db.execute(sql`
      SELECT * FROM agent_cooldowns WHERE agent_name = ${agentName} AND cooldown_key = ${key}
    `);
    const row = result.rows[0];
    if (!row) return { agent_name: agentName, cooldown_key: key, last_run_at: null, run_count: 0 };
    return row;
  });

  app.put("/api/cooldowns/:agentName/:key", async (request, reply) => {
    const project = await requireProjectFromApiKey(request, reply);
    if (!project) return;
    const { agentName, key } = request.params as { agentName: string; key: string };
    const agent = await ctx.agentRepo.findByProjectAndName(project.id, agentName);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    const body = (request.body as { last_run_at?: string }) ?? {};
    const now = body.last_run_at ?? new Date().toISOString();
    await ctx.db.execute(sql`
      INSERT INTO agent_cooldowns (agent_name, cooldown_key, last_run_at, run_count)
      VALUES (${agentName}, ${key}, ${now}, 1)
      ON CONFLICT (agent_name, cooldown_key)
      DO UPDATE SET last_run_at = ${now}, run_count = agent_cooldowns.run_count + 1
    `);
    return { ok: true };
  });

  // ── Projects (Dashboard API) ──
  app.get("/api/projects", async () => {
    const rows = await ctx.projectRepo.findAll();
    return rows.map(serializeProject);
  });

  app.post("/api/projects", async (request, reply) => {
    const parsed = projectCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_project_create" });
    }
    const body = parsed.data;
    const existing = await ctx.projectRepo.findByName(body.name);
    if (existing) {
      return reply.status(409).send({ error: "project_already_exists" });
    }

    const apiKey = body.apiKey ?? generateProjectApiKey();
    const project = await ctx.projectRepo.create({
      name: body.name,
      displayName: body.displayName ?? body.name,
      description: body.description,
      apiKeyHash: hashApiKey(apiKey),
    });

    return reply.status(201).send({
      project: serializeProject(project),
      api_key: apiKey,
    });
  });

  app.post("/api/projects/:id/api-key", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await ctx.projectRepo.findById(id);
    if (!project) {
      return reply.status(404).send({ error: "project_not_found" });
    }

    const apiKey = generateProjectApiKey();
    const updated = await ctx.projectRepo.update(id, {
      apiKeyHash: hashApiKey(apiKey),
    });
    return {
      project: serializeProject(updated ?? project),
      api_key: apiKey,
    };
  });

  app.post("/api/projects/:id/drain", async (request, reply) => {
    const parsed = projectDrainSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_project_drain" });
    }

    const { id } = request.params as { id: string };
    const project = await ctx.projectRepo.findById(id);
    if (!project) {
      return reply.status(404).send({ error: "project_not_found" });
    }

    const projectAgents = await ctx.agentRepo.findAll({ projectId: id });
    let cancelledQueued = 0;
    let cancelledRunning = 0;
    for (const agent of projectAgents) {
      await ctx.agentRepo.update(agent.id, {
        enabled: false,
        executorStatus: "offline",
        activeExecutionCount: parsed.data.cancel_running ? 0 : agent.activeExecutionCount,
      } as any);
      const cancelled = await ctx.executionRepo.cancelActiveForAgent(agent.id, {
        cancelRunning: parsed.data.cancel_running,
        errorMessage: "Cancelled by project drain",
      });
      cancelledQueued += cancelled.queued;
      cancelledRunning += cancelled.running;
      broadcast({ type: "agent.updated", agent_id: agent.id, enabled: false, executor_status: "offline" });
    }

    const refreshedAgents = await ctx.agentRepo.findAll({ projectId: id });
    const activeExecutionCount = refreshedAgents.reduce(
      (total, agent) => total + agent.activeExecutionCount,
      0,
    );
    if (cancelledQueued > 0 || cancelledRunning > 0) {
      broadcast({ type: "executions.cancelled", project_id: id, reason: "project_drain" });
    }

    return {
      ok: true,
      project_id: id,
      agents_drained: projectAgents.length,
      cancelled_queued: cancelledQueued,
      cancelled_running: cancelledRunning,
      active_execution_count: activeExecutionCount,
    };
  });

  // ── Agents (Dashboard API) ──
  app.get("/api/agents", async (request, reply) => {
    const { project, type, status, archived } = request.query as Record<string, string | undefined>;
    const archiveFilter = parseAgentArchiveFilter(archived);
    if (!archiveFilter) {
      return reply.status(400).send({ error: "invalid_archived_filter" });
    }
    return ctx.agentRepo.findAll({
      projectId: project,
      agentType: type,
      executorStatus: status,
      archived: archiveFilter,
    });
  });

  app.post("/api/agents", async (request, reply) => {
    const parsed = dashboardAgentCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(validationErrorPayload(parsed.error, "invalid_agent_create"));
    }
    const body = parsed.data;

    const project = body.projectId
      ? await ctx.projectRepo.findById(body.projectId)
      : await ctx.projectRepo.findByName("default");
    if (!project || project.status !== "active") {
      return reply.status(404).send({ error: "project_not_found" });
    }

    if (body.cronExpression) {
      try { new Cron(body.cronExpression); } catch {
        return reply.status(400).send({ error: "invalid_cron_expression" });
      }
    }

    const existing = await ctx.agentRepo.findByProjectAndName(project.id, body.name);
    const agent = await ctx.agentRepo.upsert(project.id, body.name, {
      displayName: body.displayName,
      description: body.description,
      agentType: body.agentType,
      cronExpression: body.cronExpression ?? null,
      handlerName: body.handlerName ?? null,
      enabled: body.enabled,
      misfirePolicy: body.misfirePolicy,
      concurrency: body.concurrency,
      maxPendingQueue: body.maxPendingQueue,
      timeoutSeconds: body.timeoutSeconds,
      retryMax: body.retryMax,
      retryBackoffBaseMs: body.retryBackoffBaseMs,
      maxTurns: body.maxTurns ?? null,
      maxCostUsd: body.maxCostUsd !== undefined && body.maxCostUsd !== null
        ? body.maxCostUsd.toString() as any
        : null,
      inputSchema: body.inputSchema as any ?? null,
      allowTriggerBy: body.allowTriggerBy as any ?? null,
      idempotencyWindowSeconds: body.idempotencyWindowSeconds,
      labels: body.labels as any ?? {},
      executorStatus: "offline",
      lastHeartbeatAt: null,
    });
    broadcast({ type: "agent.updated", agent });
    return reply.status(existing ? 200 : 201).send(agent);
  });

  app.get("/api/agents/:id", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const agent = await ctx.agentRepo.findById((request.params as any).id, {
      includeArchived: queryFlag(query.include_archived),
    });
    if (!agent) return reply.status(404).send({ error: "not found" });
    const recentExecs = await ctx.executionRepo.findAll({
      agentId: agent.id, limit: 10,
    });
    return { ...agent, recentExecutions: recentExecs };
  });

  app.patch("/api/agents/:id", async (request, reply) => {
    const parsed = agentPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_agent_patch" });
    }
    const body = parsed.data;
    if (body.cronExpression) {
      try { new Cron(body.cronExpression); } catch {
        return reply.status(400).send({ error: "invalid_cron_expression" });
      }
    }
    const update = {
      ...body,
      maxCostUsd: body.maxCostUsd !== undefined && body.maxCostUsd !== null
        ? body.maxCostUsd.toString() as any
        : body.maxCostUsd,
    };
    const agent = await ctx.agentRepo.update((request.params as any).id, update as any);
    if (!agent) return reply.status(404).send({ error: "not found" });
    return agent;
  });

  app.delete("/api/agents/:id", async (request, reply) => {
    const id = (request.params as any).id;
    const agent = await ctx.agentRepo.findById(id);
    if (!agent) return reply.status(404).send({ error: "not found" });
    const activeExecutionCount = await ctx.executionRepo.countByAgentAndStatus(id, ["queued", "running"]);
    if (activeExecutionCount > 0) {
      return reply.status(409).send({
        error: "agent_has_active_executions",
        active_execution_count: activeExecutionCount,
      });
    }
    await ctx.agentRepo.delete(id);
    broadcast({ type: "agent.deleted", agent });
    return reply.status(204).send();
  });

  app.post("/api/agents/:id/drain", async (request, reply) => {
    if (!isValidDashboardBasicAuth(request)) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const parsed = agentDrainSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_agent_drain" });
    }

    const id = (request.params as any).id;
    const agent = await ctx.agentRepo.findById(id);
    if (!agent) return reply.status(404).send({ error: "not found" });

    await ctx.agentRepo.update(id, {
      enabled: false,
      executorStatus: "offline",
      activeExecutionCount: parsed.data.cancel_running ? 0 : agent.activeExecutionCount,
    } as any);
    const cancelled = await ctx.executionRepo.cancelActiveForAgent(id, {
      cancelRunning: parsed.data.cancel_running,
      errorMessage: "Cancelled by agent drain",
    });
    if (cancelled.running > 0 && !parsed.data.cancel_running) {
      await ctx.agentRepo.decrementExecutionCountBy(id, cancelled.running);
    }

    const refreshedAgent = await ctx.agentRepo.findById(id);
    broadcast({ type: "agent.updated", agent_id: id, enabled: false, executor_status: "offline" });
    if (cancelled.queued > 0 || cancelled.running > 0) {
      broadcast({ type: "executions.cancelled", agent_id: id, reason: "agent_drain" });
    }
    return {
      ok: true,
      agent_id: id,
      cancelled_queued: cancelled.queued,
      cancelled_running: cancelled.running,
      active_execution_count: refreshedAgent?.activeExecutionCount ?? 0,
    };
  });

  app.patch("/api/agents/bulk", async (request, reply) => {
    const parsed = bulkAgentPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "project_and_enabled_required" });
    }
    const { project, enabled } = parsed.data;
    const projectAgents = await ctx.agentRepo.findAll({ projectId: project });
    for (const agent of projectAgents) {
      await ctx.agentRepo.update(agent.id, { enabled } as any);
    }
    return { ok: true, count: projectAgents.length };
  });

  app.get("/api/agents/:id/schedule-preview", async (request, reply) => {
    const parsed = schedulePreviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_schedule_preview_query" });
    }
    const agent = await ctx.agentRepo.findById((request.params as any).id);
    if (!agent || !agent.cronExpression) return { runs: [] };
    const cron = new Cron(agent.cronExpression);
    const now = new Date();
    const previews = [];
    let cursor = now;
    for (let i = 0; i < parsed.data.limit; i++) {
      const next = cron.nextRun(cursor);
      if (!next) break;
      previews.push(next.toISOString());
      cursor = new Date(next.getTime() + 1);
    }
    return { runs: previews };
  });

  // ── Executions (Dashboard API) ──
  app.get("/api/executions", async (request) => {
    const { project, agent_id, status, trigger_type, since, limit, offset } = request.query as Record<string, string>;
    return ctx.executionRepo.findAll({
      projectId: project,
      agentId: agent_id,
      status,
      triggerType: trigger_type,
      since: since ? new Date(since) : undefined,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
    });
  });

  app.get("/api/executions/:id", async (request, reply) => {
    const exec = await ctx.executionRepo.findById((request.params as any).id);
    if (!exec) return reply.status(404).send({ error: "not found" });
    return exec;
  });

  app.get("/api/executions/:id/traces", async (request) => {
    return ctx.traceRepo.findByExecution((request.params as any).id);
  });

  app.get("/api/executions/:id/trigger-chain", async (request) => {
    const result = await ctx.executionRepo.findTriggerChain((request.params as any).id, "both");
    return result?.rows ?? [];
  });

  app.post("/api/executions/:id/cancel", async (request, reply) => {
    if (!isValidDashboardBasicAuth(request)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
    const { id } = request.params as { id: string };
    const exec = await ctx.executionRepo.findById(id);
    if (!exec) return reply.status(404).send({ error: "not found" });
    if (isTerminalExecutionStatus(exec.status)) {
      return reply.status(409).send({ error: "execution_already_terminal", status: exec.status });
    }

    const cancelled = await ctx.executionRepo.updateStatus(id, "cancelled", {
      finishedAt: new Date(),
      durationMs: durationSince(exec.startedAt),
      errorMessage: "Cancelled by dashboard",
      lastActivityAt: new Date(),
    });
    if (exec.status === "running") {
      await ctx.agentRepo.decrementExecutionCount(exec.agentId);
    }
    broadcast({ type: "execution.updated", execution: cancelled });
    return { ok: true, status: "cancelled" };
  });

  app.post("/api/executions/:id/rerun", async (request, reply) => {
    if (!isValidDashboardBasicAuth(request)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
    const { id } = request.params as { id: string };
    const exec = await ctx.executionRepo.findById(id);
    if (!exec) return reply.status(404).send({ error: "not found" });
    const agent = await ctx.agentRepo.findById(exec.agentId);
    if (!agent) return reply.status(404).send({ error: "agent not found" });

    const rerun = await ctx.executionRepo.create({
      agentId: exec.agentId,
      triggerType: "manual",
      triggeredBy: `rerun:${exec.id}`,
      status: "queued",
      scheduledAt: new Date(),
      inputPayload: exec.inputPayload as any,
      triggerDepth: 0,
      idempotencyKey: null,
    } as any);

    broadcast({ type: "execution.created", execution: rerun });
    return reply.status(202).send({
      execution_id: rerun.id,
      source_execution_id: exec.id,
      status: "queued",
    });
  });

  // ── Executors (Dashboard API) ──
  app.get("/api/executors", async (request) => {
    const { project } = request.query as Record<string, string>;
    const onlineAgents = await ctx.agentRepo.findAll({
      projectId: project,
      executorStatus: "online",
    });
    return onlineAgents.map(a => ({
      agent_name: a.name,
      executor_host: a.executorHost,
      executor_status: a.executorStatus,
      last_heartbeat_at: a.lastHeartbeatAt,
      active_executions: a.activeExecutionCount,
    }));
  });

  // ── Stats ──
  app.get("/api/stats", async () => {
    const allAgents = await ctx.agentRepo.findAll({});
    const recentExecs = await ctx.executionRepo.findAll({ limit: 200 });
    const succeeded = recentExecs.filter(e => e.status === "success").length;
    const failed = recentExecs.filter(e => e.status === "failed").length;
    return {
      agents_total: allAgents.length,
      agents_online: allAgents.filter(a => a.executorStatus === "online").length,
      recent_success_rate: recentExecs.length > 0 ? (succeeded / recentExecs.length * 100).toFixed(1) : "0",
      recent_failures: failed,
    };
  });

  app.get("/api/alerts", async (request, reply) => {
    const parsed = alertsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_alerts_query" });
    }
    return ctx.alertRepo.findRecent(
      parsed.data.limit,
      parsed.data.include_acknowledged,
    );
  });

  app.post("/api/alerts/:id/acknowledge", async (request, reply) => {
    const { id } = request.params as { id: string };
    const alertId = Number.parseInt(id, 10);
    if (!Number.isFinite(alertId) || alertId < 1) {
      return reply.status(400).send({ error: "invalid_alert_id" });
    }

    const parsed = alertAcknowledgeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_alert_acknowledge" });
    }

    const alert = await ctx.alertRepo.acknowledge(
      alertId,
      parsed.data.acknowledgedBy ?? serverConfig.dashboardUsername,
    );
    if (!alert) return reply.status(404).send({ error: "alert_not_found" });

    broadcast({ type: "alert.acknowledged", alert_id: alert.id });
    return alert;
  });

  // ── WebSocket with Pub/Sub ──
  app.get("/ws", { websocket: true }, (socket, _req) => {
    wsClients.add(socket);
    socket.on("close", () => { wsClients.delete(socket); });
    socket.on("error", () => { wsClients.delete(socket); });
    socket.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  });

  // ── LLM Proxy ──
  app.post("/v1/messages", createLlmProxyHandler({
    proxyTokenRepo: ctx.proxyTokenRepo,
    traceRepo: ctx.traceRepo,
    executionRepo: ctx.executionRepo,
    anthropicApiKey: serverConfig.anthropicApiKey,
    anthropicEndpoint: serverConfig.anthropicEndpoint,
  }));
}
