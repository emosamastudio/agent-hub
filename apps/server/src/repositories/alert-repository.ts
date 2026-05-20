import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { alertLog, agents } from "../db/schema.js";
import type { Db } from "../db/repository.js";

type AlertCreateInput = {
  ruleName: string;
  severity: string;
  agentId?: string | null;
  message: string;
  context?: Record<string, unknown>;
};

export class AlertRepository {
  constructor(private db: Db) {}

  async createOnce(input: AlertCreateInput, dedupeSeconds: number) {
    const since = new Date(Date.now() - dedupeSeconds * 1000);
    const agentCondition = input.agentId
      ? eq(alertLog.agentId, input.agentId)
      : isNull(alertLog.agentId);
    const existing = await this.db.select({ id: alertLog.id })
      .from(alertLog)
      .where(and(
        eq(alertLog.ruleName, input.ruleName),
        agentCondition,
        gte(alertLog.createdAt, since),
      ))
      .limit(1);
    if (existing.length > 0) return null;

    const rows = await this.db.insert(alertLog).values({
      ruleName: input.ruleName,
      severity: input.severity,
      agentId: input.agentId ?? null,
      message: input.message,
      context: input.context ?? {},
    }).returning();
    return rows[0] ?? null;
  }

  private selectDashboardAlerts() {
    return this.db.select({
      id: alertLog.id,
      ruleName: alertLog.ruleName,
      severity: alertLog.severity,
      agentId: alertLog.agentId,
      agentName: agents.name,
      agentDisplayName: agents.displayName,
      message: alertLog.message,
      context: alertLog.context,
      acknowledgedAt: alertLog.acknowledgedAt,
      acknowledgedBy: alertLog.acknowledgedBy,
      createdAt: alertLog.createdAt,
    });
  }

  async findRecent(limit = 20, includeAcknowledged = false) {
    const query = this.selectDashboardAlerts()
      .from(alertLog)
      .leftJoin(agents, eq(alertLog.agentId, agents.id));

    if (includeAcknowledged) {
      return query
        .orderBy(desc(alertLog.createdAt))
        .limit(limit);
    }

    return query
      .where(isNull(alertLog.acknowledgedAt))
      .orderBy(desc(alertLog.createdAt))
      .limit(limit);
  }

  async acknowledge(id: number, acknowledgedBy: string) {
    const rows = await this.db.update(alertLog)
      .set({
        acknowledgedAt: new Date(),
        acknowledgedBy,
      })
      .where(eq(alertLog.id, id))
      .returning({
        id: alertLog.id,
        ruleName: alertLog.ruleName,
        severity: alertLog.severity,
        agentId: alertLog.agentId,
        message: alertLog.message,
        context: alertLog.context,
        acknowledgedAt: alertLog.acknowledgedAt,
        acknowledgedBy: alertLog.acknowledgedBy,
        createdAt: alertLog.createdAt,
      });
    return rows[0] ?? null;
  }

  async expireOld(retentionDays: number) {
    await this.db.execute(sql`
      DELETE FROM alert_log
      WHERE created_at < now() - interval '1 day' * ${retentionDays}
    `);
  }
}
