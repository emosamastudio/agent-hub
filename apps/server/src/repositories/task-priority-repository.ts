import type { SqliteDatabase } from "../db/index.js";
import type { TaskPriorityState } from "../shared-types.js";

interface TaskPriorityRow {
  runId: string;
  priority: TaskPriorityState["priority"];
  updatedAt: string;
}

function mapTaskPriorityRow(row: TaskPriorityRow): TaskPriorityState {
  return {
    runId: row.runId,
    priority: row.priority,
    updatedAt: row.updatedAt,
  };
}

export class TaskPriorityRepository {
  private readonly listStatement;
  private readonly getByRunIdStatement;
  private readonly upsertStatement;
  private readonly deleteStatement;

  constructor(private readonly db: SqliteDatabase) {
    const selectClause = `
      SELECT
        run_id AS runId,
        priority,
        updated_at AS updatedAt
      FROM task_priorities
    `;

    this.listStatement = db.prepare<unknown[], TaskPriorityRow>(
      `${selectClause} ORDER BY updated_at DESC`,
    );
    this.getByRunIdStatement = db.prepare<[string], TaskPriorityRow>(
      `${selectClause} WHERE run_id = ?`,
    );
    this.upsertStatement = db.prepare<TaskPriorityState>(`
      INSERT INTO task_priorities (
        run_id,
        priority,
        updated_at
      ) VALUES (
        @runId,
        @priority,
        @updatedAt
      )
      ON CONFLICT(run_id) DO UPDATE SET
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = db.prepare<[string]>(
      "DELETE FROM task_priorities WHERE run_id = ?",
    );
  }

  list(): TaskPriorityState[] {
    return this.listStatement.all().map(mapTaskPriorityRow);
  }

  getByRunId(runId: string): TaskPriorityState | null {
    const row = this.getByRunIdStatement.get(runId);
    return row ? mapTaskPriorityRow(row) : null;
  }

  upsert(priority: TaskPriorityState): void {
    this.upsertStatement.run(priority);
  }

  deleteByRunId(runId: string): void {
    this.deleteStatement.run(runId);
  }
}
