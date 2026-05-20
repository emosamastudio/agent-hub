import { and, eq, sql, lt, inArray, desc, gte, isNull } from "drizzle-orm";
import { executions, agents } from "../db/schema.js";
import type { Db } from "../db/repository.js";

export class ExecutionRepository {
  constructor(private db: Db) {}

  async create(input: typeof executions.$inferInsert) {
    const rows = await this.db.insert(executions).values(input as any).returning();
    return rows[0];
  }

  async findById(id: string) {
    const rows = await this.db.select().from(executions).where(eq(executions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findAll(filters: {
    agentId?: string; status?: string; triggerType?: string;
    since?: Date; limit?: number; offset?: number;
  }) {
    const conditions = [];
    if (filters.agentId) conditions.push(eq(executions.agentId, filters.agentId));
    if (filters.status) conditions.push(eq(executions.status, filters.status as any));
    if (filters.triggerType) conditions.push(eq(executions.triggerType, filters.triggerType as any));
    if (filters.since) conditions.push(gte(executions.createdAt, filters.since));

    let q = this.db.select().from(executions).$dynamic();
    if (conditions.length) q = q.where(and(...conditions));
    return q.orderBy(desc(executions.createdAt)).limit(filters.limit ?? 50).offset(filters.offset ?? 0);
  }

  async findQueued(agentIds?: string[]) {
    const conditions = [
      eq(executions.status, "queued" as any),
      eq(agents.enabled, true),
      isNull(agents.archivedAt),
      eq(agents.executorStatus, "online"),
      sql`${agents.activeExecutionCount} < ${agents.concurrency}`,
    ];
    if (agentIds && agentIds.length > 0) {
      conditions.push(inArray(executions.agentId, agentIds));
    }

    return this.db.select({
      execution: executions,
      agentConcurrency: agents.concurrency,
      agentExecutorStatus: agents.executorStatus,
      agentActiveCount: agents.activeExecutionCount,
      agentExecutorHost: agents.executorHost,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(and(...conditions))
    .orderBy(executions.scheduledAt)
    .limit(10);
  }

  async findTimedOut() {
    return this.db.select({
      execution: executions,
      agentTimeout: agents.timeoutSeconds,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(and(
      eq(executions.status, "running" as any),
      sql`${executions.startedAt} + (${agents.timeoutSeconds} * interval '1 second') < now()`,
    ));
  }

  async findRetriable() {
    return this.db.select({
      execution: executions,
      agentRetryMax: agents.retryMax,
      agentBackoffMs: agents.retryBackoffBaseMs,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(and(
      inArray(executions.status, ["failed", "timeout"] as any),
      sql`${executions.retryCount} < ${agents.retryMax}`,
      sql`${executions.finishedAt} + (${agents.retryBackoffBaseMs} * power(2, ${executions.retryCount}) * interval '1 ms') < now()`,
    ));
  }

  async countByAgentAndStatus(agentId: string, statuses: string[]) {
    const result = await this.db.execute(sql`
      SELECT COUNT(*)::int as cnt FROM executions
      WHERE agent_id = ${agentId} AND status IN (${sql.join(statuses.map(s => sql`${s}`), sql`, `)})
    `);
    return (result.rows[0] as any)?.cnt ?? 0;
  }

  async countByStatus() {
    const result = await this.db.execute(sql`
      SELECT status, COUNT(*)::int AS count
      FROM executions
      GROUP BY status
    `);
    const counts: Record<string, number> = {
      queued: 0,
      running: 0,
      success: 0,
      failed: 0,
      timeout: 0,
      cancelled: 0,
    };
    for (const row of result.rows as Array<{ status: string; count: number }>) {
      counts[row.status] = Number(row.count ?? 0);
    }
    return counts;
  }

  async claimForDispatch(executionId: string) {
    const result = await this.db.execute(sql`
      WITH target AS (
        SELECT id, agent_id
        FROM executions
        WHERE id = ${executionId}
          AND status = 'queued'
        FOR UPDATE
      ),
      agent_claim AS (
        UPDATE agents a
        SET active_execution_count = active_execution_count + 1
        FROM target t
        WHERE a.id = t.agent_id
          AND a.enabled = true
          AND a.archived_at IS NULL
          AND a.executor_status = 'online'
          AND a.active_execution_count < a.concurrency
        RETURNING a.id, a.name, a.handler_name, a.timeout_seconds
      ),
      claimed AS (
        UPDATE executions e
        SET status = 'running',
            started_at = now(),
            last_activity_at = now()
        FROM target t, agent_claim a
        WHERE e.id = t.id
          AND e.agent_id = a.id
        RETURNING e.*
      )
      SELECT
        c.id,
        c.agent_id,
        c.trigger_type,
        c.triggered_by,
        c.parent_execution_id,
        c.root_execution_id,
        c.trigger_depth,
        c.idempotency_key,
        c.status,
        c.scheduled_at,
        c.started_at,
        c.finished_at,
        c.duration_ms,
        c.last_activity_at,
        c.progress_percent,
        c.progress_message,
        c.input_payload,
        c.result_summary,
        c.result_data,
        c.error_message,
        c.error_stack,
        c.trace_count_expected,
        c.trace_count_actual,
        c.trace_incomplete,
        c.retry_count,
        c.retry_of,
        c.executor_host,
        c.created_at,
        a.name AS agent_name,
        a.handler_name,
        a.timeout_seconds
      FROM claimed c
      JOIN agent_claim a ON a.id = c.agent_id
    `);
    const row = result.rows[0] as any;
    return row ? mapExecutionRow(row) : null;
  }

  async updateStatus(id: string, status: string, extra: Record<string, any> = {}) {
    const rows = await this.db.update(executions).set({
      status: status as any,
      ...extra,
    } as any).where(eq(executions.id, id)).returning();
    return rows[0] ?? null;
  }

  async cancelActiveForAgent(
    agentId: string,
    options: { cancelRunning?: boolean; errorMessage?: string } = {},
  ): Promise<{ queued: number; running: number }> {
    const statuses = options.cancelRunning ? ["queued", "running"] : ["queued"];
    const result = await this.db.execute(sql`
      WITH target AS (
        SELECT id, status AS old_status
        FROM executions
        WHERE agent_id = ${agentId}
          AND status IN (${sql.join(statuses.map(s => sql`${s}`), sql`, `)})
      ),
      cancelled AS (
        UPDATE executions e
        SET status = 'cancelled',
            finished_at = now(),
            duration_ms = CASE
              WHEN e.started_at IS NULL THEN e.duration_ms
              ELSE GREATEST((EXTRACT(EPOCH FROM (now() - e.started_at)) * 1000)::int, 0)
            END,
            error_message = ${options.errorMessage ?? "Cancelled by agent drain"},
            last_activity_at = now()
        FROM target t
        WHERE e.id = t.id
        RETURNING t.old_status
      )
      SELECT old_status FROM cancelled
    `);
    return result.rows.reduce<{ queued: number; running: number }>(
      (counts, row) => {
        const status = (row as any).old_status;
        if (status === "queued") counts.queued += 1;
        if (status === "running") counts.running += 1;
        return counts;
      },
      { queued: 0, running: 0 },
    );
  }

  async timeoutRunning(id: string, extra: Record<string, any> = {}) {
    const rows = await this.db.update(executions).set({
      status: "timeout" as any,
      ...extra,
    } as any).where(and(
      eq(executions.id, id),
      eq(executions.status, "running" as any),
    )).returning();
    return rows[0] ?? null;
  }

  async completeRunning(id: string, status: "success" | "failed", extra: Record<string, any> = {}) {
    const rows = await this.db.update(executions).set({
      status,
      ...extra,
    } as any).where(and(
      eq(executions.id, id),
      eq(executions.status, "running" as any),
    )).returning();
    return rows[0] ?? null;
  }

  async incrementTraceCount(executionId: string, count: number) {
    await this.db.update(executions).set({
      traceCountActual: sql`COALESCE(${executions.traceCountActual}, 0) + ${count}`,
      lastActivityAt: new Date(),
    }).where(eq(executions.id, executionId));
  }

  async recordHeartbeatProgress(
    executionId: string,
    projectId: string,
    progress: { progressPercent?: number; progressMessage?: string },
  ) {
    const progressPercent = progress.progressPercent ?? null;
    const progressMessage = progress.progressMessage ?? null;
    const result = await this.db.execute(sql`
      UPDATE executions e
      SET progress_percent = COALESCE(${progressPercent}, e.progress_percent),
          progress_message = COALESCE(${progressMessage}, e.progress_message),
          last_activity_at = now()
      WHERE e.id = ${executionId}
        AND e.status = 'running'
        AND EXISTS (
          SELECT 1 FROM agents a
          WHERE a.id = e.agent_id
            AND a.project_id = ${projectId}
        )
      RETURNING e.*
    `);
    const row = result.rows[0] as any;
    return row ? mapExecutionRow(row) : null;
  }

  async findDuplicate(agentId: string, idempotencyKey: string, windowSeconds: number, terminalAware: boolean) {
    const statuses = terminalAware
      ? ["queued", "running", "success", "failed", "timeout", "cancelled"]
      : ["queued", "running"];
    const result = await this.db.execute(sql`
      SELECT *
      FROM executions
      WHERE agent_id = ${agentId}
        AND idempotency_key = ${idempotencyKey}
        AND created_at >= now() - (${windowSeconds} * interval '1 second')
        AND status IN (${sql.join(statuses.map(s => sql`${s}`), sql`, `)})
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = result.rows[0] as any;
    return row ? mapExecutionRow(row) : null;
  }

  async createRetryIfAbsent(sourceExecutionId: string) {
    const result = await this.db.execute(sql`
      INSERT INTO executions (
        agent_id,
        trigger_type,
        triggered_by,
        status,
        scheduled_at,
        retry_count,
        retry_of,
        input_payload,
        trigger_depth
      )
      SELECT
        e.agent_id,
        'retry',
        'retry',
        'queued',
        now(),
        e.retry_count + 1,
        e.id,
        e.input_payload,
        0
      FROM executions e
      JOIN agents a ON a.id = e.agent_id
      WHERE e.id = ${sourceExecutionId}
        AND e.status IN ('failed', 'timeout')
        AND e.retry_count < a.retry_max
        AND NOT EXISTS (
          SELECT 1 FROM executions retry WHERE retry.retry_of = e.id
        )
      RETURNING *
    `);
    const row = result.rows[0] as any;
    return row ? mapExecutionRow(row) : null;
  }

  async expireOldTraces(retentionDays: number) {
    await this.db.execute(sql`
      DELETE FROM traces WHERE created_at < now() - interval '1 day' * ${retentionDays}
    `);
  }

  async expireOldExecutions(retentionDays: number) {
    await this.db.execute(sql`
      DELETE FROM executions WHERE created_at < now() - interval '1 day' * ${retentionDays}
      AND status IN ('success', 'failed', 'cancelled', 'timeout')
    `);
  }

  async findTriggerChain(executionId: string, direction: "up" | "down" | "both") {
    const rootColumns = sql`
      executions.id,
      executions.agent_id,
      executions.trigger_type,
      executions.triggered_by,
      executions.parent_execution_id,
      executions.root_execution_id,
      executions.trigger_depth,
      executions.status,
      executions.scheduled_at,
      executions.started_at,
      executions.finished_at,
      executions.created_at
    `;
    const recursiveColumns = sql`
      e.id,
      e.agent_id,
      e.trigger_type,
      e.triggered_by,
      e.parent_execution_id,
      e.root_execution_id,
      e.trigger_depth,
      e.status,
      e.scheduled_at,
      e.started_at,
      e.finished_at,
      e.created_at
    `;

    if (direction === "up") {
      return this.db.execute(sql`
        WITH RECURSIVE ancestors AS (
          SELECT ${rootColumns}
          FROM executions
          WHERE id = ${executionId}
          UNION
          SELECT ${recursiveColumns}
          FROM executions e
          JOIN ancestors a ON e.id = a.parent_execution_id
        )
        SELECT * FROM ancestors
        ORDER BY trigger_depth, created_at, id
      `);
    }

    if (direction === "down") {
      return this.db.execute(sql`
        WITH RECURSIVE descendants AS (
          SELECT ${rootColumns}
          FROM executions
          WHERE id = ${executionId}
          UNION
          SELECT ${recursiveColumns}
          FROM executions e
          JOIN descendants d ON e.parent_execution_id = d.id
        )
        SELECT * FROM descendants
        ORDER BY trigger_depth, created_at, id
      `);
    }

    return this.db.execute(sql`
      WITH RECURSIVE
        ancestors AS (
          SELECT ${rootColumns}
          FROM executions
          WHERE id = ${executionId}
          UNION
          SELECT ${recursiveColumns}
          FROM executions e
          JOIN ancestors a ON e.id = a.parent_execution_id
        ),
        descendants AS (
          SELECT ${rootColumns}
          FROM executions
          WHERE id = ${executionId}
          UNION
          SELECT ${recursiveColumns}
          FROM executions e
          JOIN descendants d ON e.parent_execution_id = d.id
        ),
        chain AS (
          SELECT * FROM ancestors
          UNION
          SELECT * FROM descendants
        )
      SELECT * FROM chain
      ORDER BY trigger_depth, created_at, id
    `);
  }
}

function mapExecutionRow(row: any) {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? undefined,
    handlerName: row.handler_name ?? undefined,
    timeoutSeconds: row.timeout_seconds ?? undefined,
    triggerType: row.trigger_type,
    triggeredBy: row.triggered_by,
    parentExecutionId: row.parent_execution_id,
    rootExecutionId: row.root_execution_id,
    triggerDepth: row.trigger_depth,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    lastActivityAt: row.last_activity_at,
    progressPercent: row.progress_percent,
    progressMessage: row.progress_message,
    inputPayload: row.input_payload,
    resultSummary: row.result_summary,
    resultData: row.result_data,
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    traceCountExpected: row.trace_count_expected,
    traceCountActual: row.trace_count_actual,
    traceIncomplete: row.trace_incomplete,
    retryCount: row.retry_count,
    retryOf: row.retry_of,
    executorHost: row.executor_host,
    createdAt: row.created_at,
  };
}
