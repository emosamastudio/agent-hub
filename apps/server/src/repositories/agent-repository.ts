import { and, eq, inArray, isNotNull, isNull, sql, lt } from "drizzle-orm";
import { agents } from "../db/schema.js";
import type { Db } from "../db/repository.js";

type AgentRow = typeof agents.$inferSelect;
type AgentLookupOptions = { includeArchived?: boolean };
type AgentArchiveFilter = "active" | "include" | "only";

export class AgentRepository {
  constructor(private db: Db) {}

  async findAll(filters?: {
    projectId?: string;
    agentType?: string;
    executorStatus?: string;
    enabled?: boolean;
    includeArchived?: boolean;
    archived?: AgentArchiveFilter;
  }) {
    const conditions = [];
    if (filters?.archived === "only") {
      conditions.push(isNotNull(agents.archivedAt));
    } else if (filters?.archived !== "include" && !filters?.includeArchived) {
      conditions.push(isNull(agents.archivedAt));
    }
    if (filters?.projectId) conditions.push(eq(agents.projectId, filters.projectId));
    if (filters?.agentType) conditions.push(eq(agents.agentType, filters.agentType));
    if (filters?.executorStatus) conditions.push(eq(agents.executorStatus, filters.executorStatus));
    if (filters?.enabled !== undefined) conditions.push(eq(agents.enabled, filters.enabled));

    let q = this.db.select().from(agents).$dynamic();
    if (conditions.length) q = q.where(and(...conditions));
    return q.orderBy(agents.createdAt);
  }

  async findById(id: string, options: AgentLookupOptions = {}) {
    const conditions = [eq(agents.id, id)];
    if (!options.includeArchived) conditions.push(isNull(agents.archivedAt));
    const rows = await this.db.select().from(agents).where(and(...conditions)).limit(1);
    return rows[0] ?? null;
  }

  async findByProjectAndName(projectId: string, name: string, options: AgentLookupOptions = {}) {
    const conditions = [eq(agents.projectId, projectId), eq(agents.name, name)];
    if (!options.includeArchived) conditions.push(isNull(agents.archivedAt));
    const rows = await this.db.select().from(agents).where(
      and(...conditions)
    ).limit(1);
    return rows[0] ?? null;
  }

  async findByProjectAndNames(projectId: string, names: string[]) {
    if (names.length === 0) return [];
    return this.db.select().from(agents).where(
      and(eq(agents.projectId, projectId), inArray(agents.name, names), isNull(agents.archivedAt))
    ).orderBy(agents.createdAt);
  }

  async findEnabledWithCron() {
    return this.db.select().from(agents)
      .where(and(eq(agents.enabled, true), isNull(agents.archivedAt), sql`${agents.cronExpression} IS NOT NULL`))
      .orderBy(agents.createdAt);
  }

  async findWithStaleHeartbeat(thresholdSeconds: number) {
    return this.db.select().from(agents).where(
      and(
        eq(agents.executorStatus, "online"),
        isNull(agents.archivedAt),
        lt(agents.lastHeartbeatAt, sql`now() - interval '${sql.raw(String(thresholdSeconds))} seconds'`)
      )
    );
  }

  async upsert(projectId: string, name: string, input: Partial<typeof agents.$inferInsert>) {
    const existing = await this.findByProjectAndName(projectId, name, { includeArchived: true });
    if (existing) {
      const update: Partial<AgentRow> = { ...input, updatedAt: new Date() } as Partial<AgentRow>;
      if (existing.archivedAt) {
        update.archivedAt = null;
        update.enabled = input.enabled ?? true;
        update.activeExecutionCount = 0;
      }
      const rows = await this.db.update(agents).set(update as any)
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

  async decrementExecutionCountBy(id: string, count: number) {
    if (count <= 0) return;
    await this.db.update(agents).set({
      activeExecutionCount: sql`GREATEST(${agents.activeExecutionCount} - ${count}, 0)`,
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
    await this.db.update(agents).set({
      archivedAt: new Date(),
      enabled: false,
      executorStatus: "offline",
      activeExecutionCount: 0,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));
  }

  async deregisterByName(projectId: string, name: string) {
    await this.db.update(agents).set({
      archivedAt: new Date(),
      enabled: false,
      executorStatus: "offline",
      activeExecutionCount: 0,
      updatedAt: new Date(),
    }).where(and(eq(agents.projectId, projectId), eq(agents.name, name), isNull(agents.archivedAt)));
  }
}
