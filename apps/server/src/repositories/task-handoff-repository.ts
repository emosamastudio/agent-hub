import type { SqliteDatabase } from "../db/index.js";
import type { TaskHandoffState } from "../shared-types.js";

interface TaskHandoffRow {
  runId: string;
  targetOwner: string;
  note: string | null;
  requestedAt: string;
  updatedAt: string;
}

function mapTaskHandoffRow(row: TaskHandoffRow): TaskHandoffState {
  return {
    runId: row.runId,
    targetOwner: row.targetOwner,
    note: row.note,
    requestedAt: row.requestedAt,
    updatedAt: row.updatedAt,
  };
}

export class TaskHandoffRepository {
  private readonly listStatement;
  private readonly getByRunIdStatement;
  private readonly upsertStatement;
  private readonly deleteStatement;

  constructor(private readonly db: SqliteDatabase) {
    const selectClause = `
      SELECT
        run_id AS runId,
        target_owner AS targetOwner,
        note,
        requested_at AS requestedAt,
        updated_at AS updatedAt
      FROM task_handoffs
    `;

    this.listStatement = db.prepare<unknown[], TaskHandoffRow>(
      `${selectClause} ORDER BY updated_at DESC`,
    );
    this.getByRunIdStatement = db.prepare<[string], TaskHandoffRow>(
      `${selectClause} WHERE run_id = ?`,
    );
    this.upsertStatement = db.prepare<TaskHandoffState>(`
      INSERT INTO task_handoffs (
        run_id,
        target_owner,
        note,
        requested_at,
        updated_at
      ) VALUES (
        @runId,
        @targetOwner,
        @note,
        @requestedAt,
        @updatedAt
      )
      ON CONFLICT(run_id) DO UPDATE SET
        target_owner = excluded.target_owner,
        note = excluded.note,
        requested_at = excluded.requested_at,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = db.prepare<[string]>(
      "DELETE FROM task_handoffs WHERE run_id = ?",
    );
  }

  list(): TaskHandoffState[] {
    return this.listStatement.all().map(mapTaskHandoffRow);
  }

  getByRunId(runId: string): TaskHandoffState | null {
    const row = this.getByRunIdStatement.get(runId);
    return row ? mapTaskHandoffRow(row) : null;
  }

  upsert(handoff: TaskHandoffState): void {
    this.upsertStatement.run(handoff);
  }

  deleteByRunId(runId: string): void {
    this.deleteStatement.run(runId);
  }
}
