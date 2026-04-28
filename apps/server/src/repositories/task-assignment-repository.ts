import type { SqliteDatabase } from "../db/index.js";
import type { TaskAssignmentState } from "../shared-types.js";

interface TaskAssignmentRow {
  runId: string;
  owner: string;
  assignedAt: string;
  updatedAt: string;
}

function mapTaskAssignmentRow(row: TaskAssignmentRow): TaskAssignmentState {
  return {
    runId: row.runId,
    owner: row.owner,
    assignedAt: row.assignedAt,
    updatedAt: row.updatedAt,
  };
}

export class TaskAssignmentRepository {
  private readonly listStatement;
  private readonly getByRunIdStatement;
  private readonly upsertStatement;
  private readonly deleteStatement;

  constructor(private readonly db: SqliteDatabase) {
    const selectClause = `
      SELECT
        run_id AS runId,
        owner,
        assigned_at AS assignedAt,
        updated_at AS updatedAt
      FROM task_assignments
    `;

    this.listStatement = db.prepare<unknown[], TaskAssignmentRow>(
      `${selectClause} ORDER BY updated_at DESC`,
    );
    this.getByRunIdStatement = db.prepare<[string], TaskAssignmentRow>(
      `${selectClause} WHERE run_id = ?`,
    );
    this.upsertStatement = db.prepare<TaskAssignmentState>(`
      INSERT INTO task_assignments (
        run_id,
        owner,
        assigned_at,
        updated_at
      ) VALUES (
        @runId,
        @owner,
        @assignedAt,
        @updatedAt
      )
      ON CONFLICT(run_id) DO UPDATE SET
        owner = excluded.owner,
        assigned_at = excluded.assigned_at,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = db.prepare<[string]>(
      "DELETE FROM task_assignments WHERE run_id = ?",
    );
  }

  list(): TaskAssignmentState[] {
    return this.listStatement.all().map(mapTaskAssignmentRow);
  }

  getByRunId(runId: string): TaskAssignmentState | null {
    const row = this.getByRunIdStatement.get(runId);
    return row ? mapTaskAssignmentRow(row) : null;
  }

  upsert(assignment: TaskAssignmentState): void {
    this.upsertStatement.run(assignment);
  }

  deleteByRunId(runId: string): void {
    this.deleteStatement.run(runId);
  }
}
