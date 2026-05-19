import { Cron } from "croner";
import type { AgentRepository } from "../repositories/agent-repository.js";
import type { ExecutionRepository } from "../repositories/execution-repository.js";
import type { TraceRepository } from "../repositories/trace-repository.js";
import { serverConfig } from "../config.js";

function broadcast(event: Record<string, unknown>) {
  const fn = (globalThis as any).__hubBroadcast;
  if (fn) fn(event);
}

export interface SchedulerContext {
  agentRepo: AgentRepository;
  executionRepo: ExecutionRepository;
  traceRepo: TraceRepository;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(ctx: SchedulerContext) {
  tickTimer = setInterval(() => tick(ctx), serverConfig.schedulerTickMs);
  console.log(`Scheduler started, tick every ${serverConfig.schedulerTickMs}ms`);
}

export function stopScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

async function tick(ctx: SchedulerContext) {
  try { await cronEvaluator(ctx); } catch (e) { console.error("CronEvaluator failed:", e); }
  try { await heartbeatMonitor(ctx); } catch (e) { console.error("HeartbeatMonitor failed:", e); }
  try { await timeoutChecker(ctx); } catch (e) { console.error("TimeoutChecker failed:", e); }
  try { await retryManager(ctx); } catch (e) { console.error("RetryManager failed:", e); }
  try { await alertEvaluator(ctx); } catch (e) { console.error("AlertEvaluator failed:", e); }
  try { await retentionCleanup(ctx); } catch (e) { console.error("RetentionCleanup failed:", e); }
  try { await matcher(ctx); } catch (e) { console.error("Matcher failed:", e); }
}

// ─── CronEvaluator ───
async function cronEvaluator(ctx: SchedulerContext) {
  const enabledAgents = await ctx.agentRepo.findEnabledWithCron();
  for (const agent of enabledAgents) {
    if (!agent.cronExpression) continue;
    const cron = new Cron(agent.cronExpression);
    const lastRun = agent.lastExecutionAt ?? new Date(0);
    const nextRun = cron.nextRun(lastRun);
    if (!nextRun || nextRun > new Date()) continue;

    const pending = await ctx.executionRepo.countByAgentAndStatus(agent.id, ["queued", "running"]);
    if (pending >= agent.maxPendingQueue) {
      console.warn(`Agent ${agent.name}: max_pending_queue (${agent.maxPendingQueue}) reached (${pending} pending), skipping cron`);
      continue;
    }

    const availableSlots = agent.maxPendingQueue - pending;

    if (agent.misfirePolicy === "drop") {
      // Skip, wait for next natural trigger
    } else if (agent.misfirePolicy === "fire_once") {
      await ctx.executionRepo.create({
        agentId: agent.id,
        triggerType: "cron",
        triggeredBy: "cron",
        status: "queued",
        scheduledAt: new Date(),
        triggerDepth: 0,
      });
    } else if (agent.misfirePolicy === "fire_all") {
      const maxLookback = new Date(Date.now() - 60 * 60 * 1000);
      let cursor = new Date(Math.max(lastRun.getTime() + 1, maxLookback.getTime()));
      let toCreate = 0;
      while (toCreate < availableSlots) {
        const next = cron.nextRun(cursor);
        if (!next || next > new Date()) break;
        toCreate++;
        cursor = new Date(next.getTime() + 1);
      }
      for (let i = 0; i < toCreate; i++) {
        await ctx.executionRepo.create({
          agentId: agent.id,
          triggerType: "cron",
          triggeredBy: "cron",
          status: "queued",
          scheduledAt: new Date(),
          triggerDepth: 0,
        });
      }
    }

    await ctx.agentRepo.update(agent.id, { lastExecutionAt: new Date() } as any);
  }
}

// ─── HeartbeatMonitor ───
async function heartbeatMonitor(ctx: SchedulerContext) {
  const stale = await ctx.agentRepo.findWithStaleHeartbeat(30);
  for (const agent of stale) {
    await ctx.agentRepo.markOffline(agent.id);
    broadcast({ type: "agent.updated", agent_id: agent.id, executor_status: "offline" });
    const running = await ctx.executionRepo.findAll({ agentId: agent.id, status: "running", limit: 100 });
    for (const exec of running) {
      await ctx.executionRepo.updateStatus(exec.id, "cancelled");
      await ctx.agentRepo.decrementExecutionCount(agent.id);
    }
  }
}

// ─── TimeoutChecker ───
async function timeoutChecker(ctx: SchedulerContext) {
  const timedOut = await ctx.executionRepo.findTimedOut();
  for (const row of timedOut) {
    await ctx.executionRepo.updateStatus(row.execution.id, "timeout", {
      finishedAt: new Date(),
      errorMessage: `Execution exceeded timeout of ${row.agentTimeout}s`,
    } as any);
    await ctx.agentRepo.decrementExecutionCount(row.execution.agentId);
  }
}

// ─── RetryManager ───
async function retryManager(ctx: SchedulerContext) {
  const retriable = await ctx.executionRepo.findRetriable();
  for (const row of retriable) {
    const newCount = row.execution.retryCount + 1;
    await ctx.executionRepo.create({
      agentId: row.execution.agentId,
      triggerType: "retry",
      triggeredBy: "retry",
      status: "queued",
      scheduledAt: new Date(),
      retryCount: newCount,
      retryOf: row.execution.id,
      inputPayload: row.execution.inputPayload,
      triggerDepth: 0,
    });
  }
}

// ─── Matcher (Phase 1: no-op — dispatch handled in poll route) ───
async function matcher(_ctx: SchedulerContext) {
  // Phase 1: no-op. Dispatch happens in GET /api/executors/poll.
}

// ─── AlertEvaluator ───
let alertTickCount = 0;
async function alertEvaluator(_ctx: SchedulerContext) {
  alertTickCount++;
  if (alertTickCount % 10 !== 0) return; // every 10 ticks (10s)
  // Implemented fully in Task 8 (dashboard API)
}

// ─── RetentionCleanup (once per day) ───
let lastCleanupDate = "";
async function retentionCleanup(ctx: SchedulerContext) {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastCleanupDate) return;
  lastCleanupDate = today;
  await ctx.executionRepo.expireOldTraces(serverConfig.traceRetentionDays);
  await ctx.executionRepo.expireOldExecutions(serverConfig.executionRetentionDays);
}
