import { eq, sql } from "drizzle-orm";
import { traces } from "../db/schema.js";
import type { Db } from "../db/repository.js";

export class TraceRepository {
  constructor(private db: Db) {}

  async getNextTurnIndex(executionId: string): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT COALESCE(MAX(turn_index), -1) + 1 as next_turn
      FROM traces
      WHERE execution_id = ${executionId}
    `);
    const row = result.rows[0] as { next_turn: number } | undefined;
    return row?.next_turn ?? 0;
  }

  async insertBatch(rows: Array<{
    executionId: string; turnIndex: number; spanIndex?: number;
    parentSpanId?: string | null; role: string; spanType?: string;
    model?: string; provider?: string;
    inputContent?: string; outputContent?: string;
    toolCalls?: any; toolResults?: any;
    inputTokens?: number; outputTokens?: number;
    costEstimate?: string; latencyMs?: number;
    metadata?: any;
  }>) {
    if (rows.length === 0) return [];
    return this.db.insert(traces).values(
      rows.map(r => ({
        executionId: r.executionId,
        turnIndex: r.turnIndex,
        spanIndex: r.spanIndex ?? 0,
        parentSpanId: r.parentSpanId ?? null,
        role: r.role as any,
        spanType: r.spanType ?? "llm",
        model: r.model ?? null,
        provider: r.provider ?? null,
        inputContent: r.inputContent ?? null,
        outputContent: r.outputContent ?? null,
        toolCalls: r.toolCalls ?? null,
        toolResults: r.toolResults ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        costEstimate: r.costEstimate ?? null,
        latencyMs: r.latencyMs ?? null,
        metadata: r.metadata ?? {},
      } as any))
    ).returning();
  }

  async findByExecution(executionId: string) {
    return this.db.select().from(traces)
      .where(eq(traces.executionId, executionId))
      .orderBy(traces.turnIndex, traces.spanIndex);
  }
}
