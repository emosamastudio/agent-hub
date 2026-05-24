import { Cron } from "croner";
import type { AgentRepository } from "../repositories/agent-repository.js";
import type { ExecutionRepository } from "../repositories/execution-repository.js";
import type { TraceRepository } from "../repositories/trace-repository.js";
import type { AlertRepository } from "../repositories/alert-repository.js";
import type { ProxyTokenRepository } from "../repositories/proxy-token-repository.js";
import { serverConfig } from "../config.js";
import { getPool } from "../db/connection.js";
import type pg from "pg";

type SchedulerLogFields = Record<string, unknown>;
export type SchedulerLogger = {
  info: (fields: SchedulerLogFields, message?: string) => void;
  warn: (fields: SchedulerLogFields, message?: string) => void;
  error: (fields: SchedulerLogFields, message?: string) => void;
};

type SchedulerStepError = {
  step: string;
  message: string;
};

function broadcast(event: Record<string, unknown>) {
  const fn = (globalThis as any).__hubBroadcast;
  if (fn) fn(event);
}

export interface SchedulerContext {
  agentRepo: AgentRepository;
  executionRepo: ExecutionRepository;
  traceRepo: TraceRepository;
  alertRepo: AlertRepository;
  proxyTokenRepo: ProxyTokenRepository;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;
const schedulerLockId = 438787;
const warningThrottleMs = 60_000;
const warningLastEmittedAt = new Map<string, number>();
const consoleSchedulerLogger: SchedulerLogger = {
  info(fields, message) {
    console.log(JSON.stringify({ level: "info", msg: message, ...fields }));
  },
  warn(fields, message) {
    console.warn(JSON.stringify({ level: "warn", msg: message, ...fields }));
  },
  error(fields, message) {
    const { err, ...rest } = fields;
    console.error(JSON.stringify({
      level: "error",
      msg: message,
      ...rest,
      error: serializeError(err),
    }));
  },
};
let schedulerLogger: SchedulerLogger = consoleSchedulerLogger;

const schedulerRuntimeStats = {
  running: false,
  tickMs: serverConfig.schedulerTickMs,
  startedAt: null as string | null,
  stoppedAt: null as string | null,
  tickInProgress: false,
  tickCount: 0,
  overlapSkippedCount: 0,
  lockSkippedCount: 0,
  lastTickStartedAt: null as string | null,
  lastTickFinishedAt: null as string | null,
  lastTickDurationMs: null as number | null,
  lastTickErrorCount: 0,
  lastTickStepErrors: [] as SchedulerStepError[],
};

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function warnThrottled(key: string, message: string) {
  const now = Date.now();
  const lastEmittedAt = warningLastEmittedAt.get(key) ?? 0;
  if (now - lastEmittedAt < warningThrottleMs) return;
  warningLastEmittedAt.set(key, now);
  schedulerLogger.warn({
    component: "scheduler",
    event: "scheduler.warning",
    key,
  }, message);
}

export function getSchedulerRuntimeStats() {
  return {
    running: schedulerRuntimeStats.running,
    tick_ms: schedulerRuntimeStats.tickMs,
    started_at: schedulerRuntimeStats.startedAt,
    stopped_at: schedulerRuntimeStats.stoppedAt,
    tick_in_progress: schedulerRuntimeStats.tickInProgress,
    tick_count: schedulerRuntimeStats.tickCount,
    overlap_skipped_count: schedulerRuntimeStats.overlapSkippedCount,
    lock_skipped_count: schedulerRuntimeStats.lockSkippedCount,
    last_tick_started_at: schedulerRuntimeStats.lastTickStartedAt,
    last_tick_finished_at: schedulerRuntimeStats.lastTickFinishedAt,
    last_tick_duration_ms: schedulerRuntimeStats.lastTickDurationMs,
    last_tick_error_count: schedulerRuntimeStats.lastTickErrorCount,
    last_tick_step_errors: schedulerRuntimeStats.lastTickStepErrors,
  };
}

export function startScheduler(
  ctx: SchedulerContext,
  options: { logger?: SchedulerLogger } = {},
) {
  schedulerLogger = options.logger ?? schedulerLogger;
  tickTimer = setInterval(() => tick(ctx), serverConfig.schedulerTickMs);
  schedulerRuntimeStats.running = true;
  schedulerRuntimeStats.tickMs = serverConfig.schedulerTickMs;
  schedulerRuntimeStats.startedAt = new Date().toISOString();
  schedulerRuntimeStats.stoppedAt = null;
  schedulerLogger.info({
    component: "scheduler",
    event: "scheduler.started",
    tickMs: serverConfig.schedulerTickMs,
  }, "Scheduler started");
}

export function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  schedulerRuntimeStats.running = false;
  schedulerRuntimeStats.stoppedAt = new Date().toISOString();
  schedulerRuntimeStats.tickInProgress = false;
  schedulerLogger.info({
    component: "scheduler",
    event: "scheduler.stopped",
  }, "Scheduler stopped");
  schedulerLogger = consoleSchedulerLogger;
}

async function tick(ctx: SchedulerContext) {
  if (tickInProgress) {
    schedulerRuntimeStats.overlapSkippedCount++;
    schedulerLogger.warn({
      component: "scheduler",
      event: "scheduler.tick.skipped",
      reason: "tick_in_progress",
    }, "Scheduler tick skipped because a previous tick is still running");
    return;
  }
  tickInProgress = true;
  schedulerRuntimeStats.tickInProgress = true;
  schedulerRuntimeStats.tickCount++;
  schedulerRuntimeStats.lastTickStartedAt = new Date().toISOString();
  schedulerRuntimeStats.lastTickFinishedAt = null;
  schedulerRuntimeStats.lastTickDurationMs = null;
  const tickStartedAt = Date.now();
  let stepErrorCount = 0;
  const stepErrors: SchedulerStepError[] = [];
  let client: pg.PoolClient | null = null;
  let lockAcquired = false;

  async function runStep(step: string, operation: () => Promise<void>) {
    const stepStartedAt = Date.now();
    try {
      await operation();
    } catch (err) {
      stepErrorCount++;
      stepErrors.push({
        step,
        message: err instanceof Error ? err.message : String(err),
      });
      schedulerLogger.error({
        component: "scheduler",
        event: "scheduler.step.failed",
        step,
        durationMs: Date.now() - stepStartedAt,
        err,
      }, `${step} failed`);
    }
  }

  try {
    client = await getPool().connect();
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [schedulerLockId],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;
    if (!lockAcquired) {
      schedulerRuntimeStats.lockSkippedCount++;
      return;
    }

    await runStep("cronEvaluator", () => cronEvaluator(ctx));
    await runStep("heartbeatMonitor", () => heartbeatMonitor(ctx));
    await runStep("timeoutChecker", () => timeoutChecker(ctx));
    await runStep("retryManager", () => retryManager(ctx));
    await runStep("alertEvaluator", () => alertEvaluator(ctx));
    await runStep("retentionCleanup", () => retentionCleanup(ctx));
    await runStep("matcher", () => matcher(ctx));
  } catch (err) {
    stepErrorCount++;
    stepErrors.push({
      step: "schedulerTick",
      message: err instanceof Error ? err.message : String(err),
    });
    schedulerLogger.error({
      component: "scheduler",
      event: "scheduler.tick.failed",
      err,
    }, "Scheduler tick failed");
  } finally {
    if (lockAcquired && client) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [schedulerLockId]);
      } catch (err) {
        stepErrorCount++;
        stepErrors.push({
          step: "advisoryUnlock",
          message: err instanceof Error ? err.message : String(err),
        });
        schedulerLogger.error({
          component: "scheduler",
          event: "scheduler.advisory_unlock.failed",
          err,
        }, "Scheduler advisory unlock failed");
      }
    }
    client?.release();
    tickInProgress = false;
    schedulerRuntimeStats.tickInProgress = false;
    schedulerRuntimeStats.lastTickFinishedAt = new Date().toISOString();
    schedulerRuntimeStats.lastTickDurationMs = Date.now() - tickStartedAt;
    schedulerRuntimeStats.lastTickErrorCount = stepErrorCount;
    schedulerRuntimeStats.lastTickStepErrors = stepErrors;
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
  await ctx.proxyTokenRepo.expireTokens();
}
