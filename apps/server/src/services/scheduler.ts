import { Cron } from "croner";
import type { AgentRepository } from "../repositories/agent-repository.js";
import type { ExecutionRepository } from "../repositories/execution-repository.js";
import type { TraceRepository } from "../repositories/trace-repository.js";
import type { AlertRepository } from "../repositories/alert-repository.js";
import { serverConfig } from "../config.js";
import { getPool } from "../db/connection.js";
import type pg from "pg";

function broadcast(event: Record<string, unknown>) {
  const fn = (globalThis as any).__hubBroadcast;
  if (fn) fn(event);
}

export interface SchedulerContext {
  agentRepo: AgentRepository;
  executionRepo: ExecutionRepository;
  traceRepo: TraceRepository;
  alertRepo: AlertRepository;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;
const schedulerLockId = 438787;
const warningThrottleMs = 60_000;
const warningLastEmittedAt = new Map<string, number>();

function warnThrottled(key: string, message: string) {
  const now = Date.now();
  const lastEmittedAt = warningLastEmittedAt.get(key) ?? 0;
  if (now - lastEmittedAt < warningThrottleMs) return;
  warningLastEmittedAt.set(key, now);
  console.warn(message);
}

export function startScheduler(ctx: SchedulerContext) {
  tickTimer = setInterval(() => tick(ctx), serverConfig.schedulerTickMs);
  console.log(`Scheduler started, tick every ${serverConfig.schedulerTickMs}ms`);
}

export function stopScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

async function tick(ctx: SchedulerContext) {
  if (tickInProgress) return;
  tickInProgress = true;
  let client: pg.PoolClient | null = null;
  let lockAcquired = false;

  try {
    client = await getPool().connect();
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [schedulerLockId],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) return;

    try { await cronEvaluator(ctx); } catch (e) { console.error("CronEvaluator failed:", e); }
    try { await heartbeatMonitor(ctx); } catch (e) { console.error("HeartbeatMonitor failed:", e); }
    try { await timeoutChecker(ctx); } catch (e) { console.error("TimeoutChecker failed:", e); }
    try { await retryManager(ctx); } catch (e) { console.error("RetryManager failed:", e); }
    try { await alertEvaluator(ctx); } catch (e) { console.error("AlertEvaluator failed:", e); }
    try { await retentionCleanup(ctx); } catch (e) { console.error("RetentionCleanup failed:", e); }
    try { await matcher(ctx); } catch (e) { console.error("Matcher failed:", e); }
  } finally {
    if (lockAcquired && client) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [schedulerLockId]);
      } catch (e) {
        console.error("Scheduler advisory unlock failed:", e);
      }
    }
    client?.release();
    tickInProgress = false;
  }
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
      warnThrottled(
        `max-pending:${agent.id}`,
        `Agent ${agent.name}: max_pending_queue (${agent.maxPendingQueue}) reached (${pending} pending), skipping cron`,
      );
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
  await recoverStaleExecutors(ctx, 30);
}

export async function recoverStaleExecutors(
  ctx: SchedulerContext,
  thresholdSeconds = 30,
): Promise<{ agentsOffline: number; executionsTimedOut: number }> {
  let agentsOffline = 0;
  let executionsTimedOut = 0;
  const stale = await ctx.agentRepo.findWithStaleHeartbeat(thresholdSeconds);
  for (const agent of stale) {
    const running = await ctx.executionRepo.findAll({ agentId: agent.id, status: "running", limit: 1000 });
    await ctx.agentRepo.markOffline(agent.id);
    agentsOffline++;
    broadcast({ type: "agent.updated", agent_id: agent.id, executor_status: "offline" });
    for (const exec of running) {
      const finishedAt = new Date();
      const timedOut = await ctx.executionRepo.timeoutRunning(exec.id, {
        finishedAt,
        durationMs: durationSince(exec.startedAt),
        lastActivityAt: finishedAt,
        errorMessage: `Executor heartbeat stale for more than ${thresholdSeconds}s`,
      } as any);
      if (timedOut) {
        executionsTimedOut++;
        broadcast({ type: "execution.updated", execution: timedOut });
      }
    }
  }
  return { agentsOffline, executionsTimedOut };
}

// ─── TimeoutChecker ───
async function timeoutChecker(ctx: SchedulerContext) {
  const timedOut = await ctx.executionRepo.findTimedOut();
  for (const row of timedOut) {
    const finishedAt = new Date();
    const updated = await ctx.executionRepo.timeoutRunning(row.execution.id, {
      finishedAt,
      durationMs: durationSince(row.execution.startedAt),
      lastActivityAt: finishedAt,
      errorMessage: `Execution exceeded timeout of ${row.agentTimeout}s`,
    } as any);
    if (updated) {
      await ctx.agentRepo.decrementExecutionCount(row.execution.agentId);
      broadcast({ type: "execution.updated", execution: updated });
    }
  }
}

// ─── RetryManager ───
async function retryManager(ctx: SchedulerContext) {
  const retriable = await ctx.executionRepo.findRetriable();
  for (const row of retriable) {
    await ctx.executionRepo.createRetryIfAbsent(row.execution.id);
  }
}

// ─── Matcher (Phase 1: no-op — dispatch handled in poll route) ───
async function matcher(_ctx: SchedulerContext) {
  // Phase 1: no-op. Dispatch happens in GET /api/executors/poll.
}

function durationSince(startedAt: Date | string | null | undefined): number | null {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return null;
  return Math.max(Date.now() - started, 0);
}

// ─── AlertEvaluator ───
let alertTickCount = 0;
const alertDedupeSeconds = {
  consecutiveFailures: 6 * 60 * 60,
  queueDepth: 6 * 60 * 60,
  timeoutCascade: 6 * 60 * 60,
};

async function alertEvaluator(ctx: SchedulerContext) {
  alertTickCount++;
  if (alertTickCount % 10 !== 0) return; // every 10 ticks (10s)
  await evaluateAlerts(ctx);
}

export async function evaluateAlerts(ctx: SchedulerContext): Promise<number> {
  const agents = await ctx.agentRepo.findAll({});
  let created = 0;

  for (const agent of agents) {
    const recent = await ctx.executionRepo.findAll({ agentId: agent.id, limit: 3 });
    const consecutiveFailures =
      recent.length === 3 &&
      recent.every((execution) => execution.status === "failed" || execution.status === "timeout");
    if (consecutiveFailures) {
      const alert = await ctx.alertRepo.createOnce({
        ruleName: "consecutive_failures",
        severity: "critical",
        agentId: agent.id,
        message: `${agent.name} has 3 consecutive failed or timed out executions.`,
        context: {
          agentName: agent.name,
          statuses: recent.map((execution) => execution.status),
          executionIds: recent.map((execution) => execution.id),
        },
      }, alertDedupeSeconds.consecutiveFailures);
      if (alert) created++;
    }

    const queued = await ctx.executionRepo.countByAgentAndStatus(agent.id, ["queued"]);
    if (queued > 10) {
      const alert = await ctx.alertRepo.createOnce({
        ruleName: "queue_depth_high",
        severity: "warning",
        agentId: agent.id,
        message: `${agent.name} has ${queued} queued executions.`,
        context: {
          agentName: agent.name,
          queued,
          maxPendingQueue: agent.maxPendingQueue,
        },
      }, alertDedupeSeconds.queueDepth);
      if (alert) created++;
    }

    const recentTimeouts = await ctx.executionRepo.findAll({
      agentId: agent.id,
      status: "timeout",
      since: new Date(Date.now() - 30 * 60 * 1000),
      limit: 3,
    });
    if (recentTimeouts.length >= 3) {
      const alert = await ctx.alertRepo.createOnce({
        ruleName: "timeout_cascade",
        severity: "critical",
        agentId: agent.id,
        message: `${agent.name} has ${recentTimeouts.length} timeouts in the last 30 minutes.`,
        context: {
          agentName: agent.name,
          timeoutCount: recentTimeouts.length,
          executionIds: recentTimeouts.map((execution) => execution.id),
        },
      }, alertDedupeSeconds.timeoutCascade);
      if (alert) created++;
    }
  }

  return created;
}

// ─── RetentionCleanup (once per day) ───
let lastCleanupDate = "";
async function retentionCleanup(ctx: SchedulerContext) {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastCleanupDate) return;
  lastCleanupDate = today;
  await ctx.executionRepo.expireOldTraces(serverConfig.traceRetentionDays);
  await ctx.executionRepo.expireOldExecutions(serverConfig.executionRetentionDays);
  await ctx.alertRepo.expireOld(serverConfig.alertRetentionDays);
}
