import { and, eq, sql, lt } from "drizzle-orm";
import { agents } from "../db/schema.js";
import type { Db } from "../db/repository.js";

type AgentRow = typeof agents.$inferSelect;

export class AgentRepository {
  constructor(private db: Db) {}

  async findAll(filters?: { projectId?: string; agentType?: string; executorStatus?: string; enabled?: boolean }) {
    const conditions = [];
    if (filters?.projectId) conditions.push(eq(agents.projectId, filters.projectId));
    if (filters?.agentType) conditions.push(eq(agents.agentType, filters.agentType));
    if (filters?.executorStatus) conditions.push(eq(agents.executorStatus, filters.executorStatus));
    if (filters?.enabled !== undefined) conditions.push(eq(agents.enabled, filters.enabled));

    let q = this.db.select().from(agents);
    if (conditions.length) q = q.where(and(...conditions));
    return q.orderBy(agents.createdAt);
  }

  async findById(id: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByProjectAndName(projectId: string, name: string) {
    const rows = await this.db.select().from(agents).where(
      and(eq(agents.projectId, projectId), eq(agents.name, name))
    ).limit(1);
    return rows[0] ?? null;
  }

  async findEnabledWithCron() {
    return this.db.select().from(agents)
      .where(and(eq(agents.enabled, true), sql`${agents.cronExpression} IS NOT NULL`))
      .orderBy(agents.createdAt);
  }

  async findWithStaleHeartbeat(thresholdSeconds: number) {
    return this.db.select().from(agents).where(
      and(
        eq(agents.executorStatus, "online"),
        lt(agents.lastHeartbeatAt, sql`now() - interval '${sql.raw(String(thresholdSeconds))} seconds'`)
      )
    );
  }

  async upsert(projectId: string, name: string, input: Partial<typeof agents.$inferInsert>) {
    const existing = await this.findByProjectAndName(projectId, name);
    if (existing) {
      const rows = await this.db.update(agents).set({ ...input, updatedAt: new Date() })
        .where(eq(agents.id, existing.id)).returning();
      return rows[0];
    }
    const rows = await this.db.insert(agents).values({
      projectId, name,
      displayName: input.displayName ?? name,
      agentType: input.agentType ?? "cron_task",
      handlerName: input.handlerName ?? null,
      cronExpression: input.cronExpression ?? null,
      inputSchema: input.inputSchema as any ?? null,
      concurrency: input.concurrency ?? 1,
      timeoutSeconds: input.timeoutSeconds ?? 600,
      retryMax: input.retryMax ?? 3,
      executorHost: input.executorHost ?? null,
      executorStatus: "online",
      ...input as any,
    }).returning();
    return rows[0];
  }

  async update(id: string, input: Partial<AgentRow>) {
    const rows = await this.db.update(agents).set({ ...input, updatedAt: new Date() } as any)
      .where(eq(agents.id, id)).returning();
    return rows[0] ?? null;
  }

  async updateHeartbeat(id: string) {
    await this.db.update(agents).set({
      lastHeartbeatAt: new Date(),
      executorStatus: "online",
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async markOffline(id: string) {
    await this.db.update(agents).set({
      executorStatus: "offline",
      activeExecutionCount: 0,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async incrementExecutionCount(id: string) {
    await this.db.update(agents).set({
      activeExecutionCount: sql`${agents.activeExecutionCount} + 1`,
    }).where(eq(agents.id, id));
  }

  async decrementExecutionCount(id: string) {
    await this.db.update(agents).set({
      activeExecutionCount: sql`GREATEST(${agents.activeExecutionCount} - 1, 0)`,
    }).where(eq(agents.id, id));
  }

  async resetAllExecutionCounts() {
    await this.db.execute(sql`
      UPDATE agents SET active_execution_count = (
        SELECT COUNT(*)::int FROM executions
        WHERE executions.agent_id = agents.id
        AND executions.status = 'running'
      )
    `);
  }

  async delete(id: string) {
    await this.db.delete(agents).where(eq(agents.id, id));
  }

  async deregisterByName(projectId: string, name: string) {
    await this.db.delete(agents).where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
  }
}
