import { and, eq, sql, lt, inArray, desc, gte } from "drizzle-orm";
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

    let q = this.db.select().from(executions);
    if (conditions.length) q = q.where(and(...conditions));
    return q.orderBy(desc(executions.createdAt)).limit(filters.limit ?? 50).offset(filters.offset ?? 0);
  }

  async findQueued() {
    return this.db.select({
      execution: executions,
      agentConcurrency: agents.concurrency,
      agentExecutorStatus: agents.executorStatus,
      agentActiveCount: agents.activeExecutionCount,
      agentExecutorHost: agents.executorHost,
    })
    .from(executions)
    .innerJoin(agents, eq(executions.agentId, agents.id))
    .where(and(
      eq(executions.status, "queued" as any),
      eq(agents.executorStatus, "online"),
      sql`${agents.activeExecutionCount} < ${agents.concurrency}`,
    ))
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

  async claimForDispatch(executionId: string) {
    const rows = await this.db.update(executions).set({
      status: "running" as any,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    }).where(and(
      eq(executions.id, executionId),
      eq(executions.status, "queued" as any),
    )).returning();
    return rows[0] ?? null;
  }

  async updateStatus(id: string, status: string, extra: Record<string, any> = {}) {
    const rows = await this.db.update(executions).set({
      status: status as any,
      ...extra,
    } as any).where(eq(executions.id, id)).returning();
    return rows[0] ?? null;
  }

  async incrementTraceCount(executionId: string, count: number) {
    await this.db.update(executions).set({
      traceCountActual: sql`COALESCE(${executions.traceCountActual}, 0) + ${count}`,
      lastActivityAt: new Date(),
    }).where(eq(executions.id, executionId));
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

  async findTriggerChain(executionId: string, _direction: "up" | "down" | "both") {
    return this.db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, agent_id, parent_execution_id, root_execution_id, trigger_depth, status, started_at
        FROM executions WHERE id = ${executionId}
        UNION ALL
        SELECT e.id, e.agent_id, e.parent_execution_id, e.root_execution_id, e.trigger_depth, e.status, e.started_at
        FROM executions e JOIN chain c ON e.id = c.parent_execution_id
      )
      SELECT * FROM chain ORDER BY trigger_depth
    `);
  }
}
