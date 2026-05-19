import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { sql } from "drizzle-orm";
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


export function registerRoutes(app: FastifyInstance, ctx: ExtendedAppContext) {
  // ── Health ──
  // Phase 1: resolve project from seed. In Phase 5, use API key → project lookup.
  let cachedProjectId: string | null = null;

  async function getProjectId(): Promise<string> {
    if (cachedProjectId) return cachedProjectId;
    const project = await ctx.projectRepo.findByName("default");
    if (!project) throw new Error("Default project not found — run seed first");
    cachedProjectId = project.id;
    return cachedProjectId;
  }

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
    const projectId = await getProjectId();
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
    const projectId = await getProjectId();
    const { name } = request.params as { name: string };
    await ctx.agentRepo.deregisterByName(projectId, name);
    return reply.status(204).send();
  });

  // ── Executor Heartbeat ──
  app.post("/api/executors/heartbeat", async (request, reply) => {
    const projectId = await getProjectId();
    const body = heartbeatSchema.parse(request.body);
    const projectAgents = await ctx.agentRepo.findAll({ projectId, enabled: true });
    for (const agent of projectAgents) {
      await ctx.agentRepo.updateHeartbeat(agent.id);
      broadcast({ type: "agent.updated", agent_id: agent.id, executor_status: "online" });
    }
    return { ok: true };
  });

  // ── Executor Poll (long-poll with 30s timeout) ──
  app.get("/api/executors/poll", async (request, reply) => {
    const projectId = await getProjectId();
    const projectAgents = await ctx.agentRepo.findAll({ projectId, enabled: true });
    const agentIds = projectAgents.map(a => a.id);
    if (agentIds.length === 0) return reply.status(204).send();

    // Poll with timeout: check every 1s for up to 30s
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const queuedExecs = await ctx.executionRepo.findQueued();
      const match = queuedExecs.find(e => agentIds.includes(e.execution.agentId));

      if (match) {
        const claimed = await ctx.executionRepo.claimForDispatch(match.execution.id);
        if (!claimed) {
          // Raced with another poller, try again
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        await ctx.agentRepo.incrementExecutionCount(match.execution.agentId);
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
    broadcast({ type: "execution.updated", execution: await ctx.executionRepo.findById(id) });
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
    broadcast({ type: "trace.appended", execution_id: id, count: rows.length });
    return { ok: true, count: rows.length };
  });

  // ── Agent Trigger ──
  app.post("/api/agents/:name/trigger", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = triggerSchema.parse(request.body);
    const projectId = await getProjectId();

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

    broadcast({ type: "execution.created", execution });
    return reply.status(202).send({ execution_id: execution.id, status: "queued", duplicate: false });
  });

  // ── Cooldowns ──
  app.get("/api/cooldowns/:agentName/:key", async (request) => {
    const { agentName, key } = request.params as { agentName: string; key: string };
    const result = await ctx.db.execute(sql`
      SELECT * FROM agent_cooldowns WHERE agent_name = ${agentName} AND cooldown_key = ${key}
    `);
    const row = result.rows[0];
    if (!row) return { agent_name: agentName, cooldown_key: key, last_run_at: null, run_count: 0 };
    return row;
  });

  app.put("/api/cooldowns/:agentName/:key", async (request) => {
    const { agentName, key } = request.params as { agentName: string; key: string };
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
    return ctx.projectRepo.findAll();
  });

  // ── Agents (Dashboard API) ──
  app.get("/api/agents", async (request) => {
    const { project, type, status } = request.query as Record<string, string>;
    return ctx.agentRepo.findAll({
      projectId: project,
      agentType: type,
      executorStatus: status,
    });
  });

  app.get("/api/agents/:id", async (request, reply) => {
    const agent = await ctx.agentRepo.findById((request.params as any).id);
    if (!agent) return reply.status(404).send({ error: "not found" });
    const recentExecs = await ctx.executionRepo.findAll({
      agentId: agent.id, limit: 10,
    });
    return { ...agent, recentExecutions: recentExecs };
  });

  app.patch("/api/agents/:id", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const agent = await ctx.agentRepo.update((request.params as any).id, body as any);
    if (!agent) return reply.status(404).send({ error: "not found" });
    return agent;
  });

  app.patch("/api/agents/bulk", async (request) => {
    const { project, enabled } = request.body as { project: string; enabled: boolean };
    const projectAgents = await ctx.agentRepo.findAll({ projectId: project });
    for (const agent of projectAgents) {
      await ctx.agentRepo.update(agent.id, { enabled } as any);
    }
    return { ok: true, count: projectAgents.length };
  });

  app.get("/api/agents/:id/schedule-preview", async (request) => {
    const agent = await ctx.agentRepo.findById((request.params as any).id);
    if (!agent || !agent.cronExpression) return { runs: [] };
    const cron = new Cron(agent.cronExpression);
    const now = new Date();
    const previews = [];
    let cursor = now;
    for (let i = 0; i < 10; i++) {
      const next = cron.nextRun(cursor);
      if (!next) break;
      previews.push(next.toISOString());
      cursor = new Date(next.getTime() + 1);
    }
    return { runs: previews };
  });

  // ── Executions (Dashboard API) ──
  app.get("/api/executions", async (request) => {
    const { agent_id, status, trigger_type, since, limit, offset } = request.query as Record<string, string>;
    return ctx.executionRepo.findAll({
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
    const exec = await ctx.executionRepo.updateStatus((request.params as any).id, "cancelled");
    if (!exec) return reply.status(404).send({ error: "not found" });
    await ctx.agentRepo.decrementExecutionCount(exec.agentId);
    return { ok: true };
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

  // ── WebSocket with Pub/Sub ──
  const wsClients = new Set<any>();

  function broadcast(event: Record<string, unknown>) {
    const msg = JSON.stringify(event);
    for (const socket of wsClients) {
      try { socket.send(msg); } catch {}
    }
  }
  (globalThis as any).__hubBroadcast = broadcast;

  app.get("/ws", { websocket: true }, (socket, _req) => {
    wsClients.add(socket);
    socket.on("close", () => { wsClients.delete(socket); });
    socket.on("error", () => { wsClients.delete(socket); });
    socket.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  });
}
