import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { z } from "zod";
import { serverConfig } from "../config.js";
import { Cron } from "croner";

interface ExtendedAppContext extends AppContext {}

const agentSpecSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
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

const triggerSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().optional(),
  dedup_policy: z.enum(["skip_if_running", "skip_if_exists", "allow_duplicate"]).default("skip_if_running"),
});

const heartbeatSchema = z.object({
  executions: z.array(z.object({
    execution_id: z.string(),
    progress_percent: z.number().optional(),
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

function getProjectId(_request: any): string {
  return "default";
}

export function registerRoutes(app: FastifyInstance, ctx: ExtendedAppContext) {
  // ── Health ──
  app.get("/api/health", async () => ({
    status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString(),
  }));

  // ── Metrics ──
  app.get("/api/metrics", async () => {
    const agents = await ctx.agentRepo.findAll({ enabled: true });
    return {
      agents_total: agents.length,
      agents_online: agents.filter(a => a.executorStatus === "online").length,
    };
  });

  // ── Agent Registry ──
  app.put("/api/registry/agents", async (request, reply) => {
    const projectId = getProjectId(request);
    const body = agentSpecSchema.parse(request.body);
    const agent = await ctx.agentRepo.upsert(projectId, body.name, {
      displayName: body.displayName,
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
    const projectId = getProjectId(request);
    const { name } = request.params as { name: string };
    await ctx.agentRepo.deregisterByName(projectId, name);
    return reply.status(204).send();
  });

  // ── Executor Heartbeat ──
  app.post("/api/executors/heartbeat", async (request, reply) => {
    const projectId = getProjectId(request);
    const body = heartbeatSchema.parse(request.body);
    const projectAgents = await ctx.agentRepo.findAll({ projectId, enabled: true });
    for (const agent of projectAgents) {
      await ctx.agentRepo.updateHeartbeat(agent.id);
    }
    return { ok: true };
  });

  // ── Executor Poll (dispatch via poll route — Phase 1 single-instance) ──
  app.get("/api/executors/poll", async (request, reply) => {
    const projectId = getProjectId(request);
    const projectAgents = await ctx.agentRepo.findAll({ projectId, enabled: true });
    const agentIds = projectAgents.map(a => a.id);
    if (agentIds.length === 0) return reply.status(204).send();

    const queuedExecs = await ctx.executionRepo.findQueued();
    const match = queuedExecs.find(e => agentIds.includes(e.execution.agentId));

    if (!match) return reply.status(204).send();

    const claimed = await ctx.executionRepo.claimForDispatch(match.execution.id);
    if (!claimed) return reply.status(204).send();

    await ctx.agentRepo.incrementExecutionCount(match.execution.agentId);
    return reply.send(claimed);
  });

  // ── Execution Report ──
  app.post("/api/executions/:id/report", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = reportSchema.parse(request.body);
    const exec = await ctx.executionRepo.findById(id);
    if (!exec) return reply.status(404).send({ error: "execution not found" });

    const durationMs = exec.startedAt ? Date.now() - new Date(exec.startedAt).getTime() : null;
    const traceIncomplete = body.trace_count_expected !== undefined
      && (exec.traceCountActual ?? 0) < body.trace_count_expected;

    await ctx.executionRepo.updateStatus(id, body.status, {
      finishedAt: new Date(),
      durationMs,
      resultSummary: body.result_summary ?? null,
      resultData: body.result_data as any,
      errorMessage: body.error_message ?? null,
      errorStack: body.error_stack ?? null,
      traceCountExpected: body.trace_count_expected ?? null,
      traceIncomplete,
    });

    await ctx.agentRepo.decrementExecutionCount(exec.agentId);
    return { ok: true };
  });

  // ── Trace Batch ──
  app.post("/api/executions/:id/traces", async (request, reply) => {
    const { id } = request.params as { id: string };
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
    }));

    await ctx.traceRepo.insertBatch(rows as any[]);
    await ctx.executionRepo.incrementTraceCount(id, rows.length);
    return { ok: true, count: rows.length };
  });

  // ── Agent Trigger ──
  app.post("/api/agents/:name/trigger", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = triggerSchema.parse(request.body);
    const projectId = getProjectId(request);

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

    return reply.status(202).send({ execution_id: execution.id, status: "queued", duplicate: false });
  });

  // ── Cooldowns (Phase 1 stub — Phase 2 full implementation) ──
  app.get("/api/cooldowns/:agentName/:key", async (_request) => {
    return { agent_name: (_request.params as any).agentName, cooldown_key: (_request.params as any).key, last_run_at: null, run_count: 0 };
  });

  app.put("/api/cooldowns/:agentName/:key", async (_request) => {
    return { ok: true };
  });

  // ── WebSocket ──
  app.get("/ws", { websocket: true }, (socket, _req) => {
    socket.on("message", (_msg) => {
      socket.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
    });
  });
}
