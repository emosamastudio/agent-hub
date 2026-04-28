import type { SqliteDatabase } from "../db/index.js";
import type { AgentRun } from "../shared-types.js";

export interface RunRow {
  id: string;
  agentId: string;
  title: string;
  state: AgentRun["state"];
  health: AgentRun["health"];
  attention: AgentRun["attention"];
  waitingReason: AgentRun["waitingReason"];
  progressPhase: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
  lastEventAt: string;
  createdAt: string;
}

interface RunRecordParams extends RunRow {}

export function mapRunRow(row: RunRow): AgentRun {
  const hasProgress =
    row.progressPhase !== null ||
    row.progressPercent !== null ||
    row.progressMessage !== null;

  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    state: row.state,
    health: row.health,
    attention: row.attention,
    waitingReason: row.waitingReason,
    progress: hasProgress
      ? {
          phase: row.progressPhase ?? "working",
          percent: row.progressPercent,
          message: row.progressMessage ?? "",
        }
      : null,
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
  };
}

function toRunParams(run: AgentRun): RunRecordParams {
  return {
    id: run.id,
    agentId: run.agentId,
    title: run.title,
    state: run.state,
    health: run.health,
    attention: run.attention,
    waitingReason: run.waitingReason,
    progressPhase: run.progress?.phase ?? null,
    progressPercent: run.progress?.percent ?? null,
    progressMessage: run.progress?.message ?? null,
    lastEventAt: run.lastEventAt,
    createdAt: run.createdAt,
  };
}

export class RunRepository {
  private readonly listStatement;
  private readonly getByIdStatement;
  private readonly nextRunningStatement;
  private readonly insertStatement;
  private readonly updateStatement;
  private readonly deleteStatement;

  constructor(private readonly db: SqliteDatabase) {
    const selectClause = `
      SELECT
        id,
        agent_id AS agentId,
        title,
        state,
        health,
        attention,
        waiting_reason AS waitingReason,
        progress_phase AS progressPhase,
        progress_percent AS progressPercent,
        progress_message AS progressMessage,
        last_event_at AS lastEventAt,
        created_at AS createdAt
      FROM runs
    `;

    this.listStatement = db.prepare<unknown[], RunRow>(
      `${selectClause} ORDER BY last_event_at DESC, created_at DESC`,
    );
    this.getByIdStatement = db.prepare<[string], RunRow>(
      `${selectClause} WHERE id = ?`,
    );
    this.nextRunningStatement = db.prepare<unknown[], RunRow>(
      `${selectClause} WHERE state = 'running' ORDER BY last_event_at ASC LIMIT 1`,
    );
    this.insertStatement = db.prepare<RunRecordParams>(`
      INSERT INTO runs (
        id,
        agent_id,
        title,
        state,
        health,
        attention,
        waiting_reason,
        progress_phase,
        progress_percent,
        progress_message,
        last_event_at,
        created_at
      ) VALUES (
        @id,
        @agentId,
        @title,
        @state,
        @health,
        @attention,
        @waitingReason,
        @progressPhase,
        @progressPercent,
        @progressMessage,
        @lastEventAt,
        @createdAt
      )
    `);
    this.updateStatement = db.prepare<RunRecordParams>(`
      UPDATE runs
      SET
        agent_id = @agentId,
        title = @title,
        state = @state,
        health = @health,
        attention = @attention,
        waiting_reason = @waitingReason,
        progress_phase = @progressPhase,
        progress_percent = @progressPercent,
        progress_message = @progressMessage,
        last_event_at = @lastEventAt,
        created_at = @createdAt
      WHERE id = @id
    `);
    this.deleteStatement = db.prepare<[string]>("DELETE FROM runs WHERE id = ?");
  }

  list(): AgentRun[] {
    return this.listStatement.all().map(mapRunRow);
  }

  getById(id: string): AgentRun | null {
    const row = this.getByIdStatement.get(id);
    return row ? mapRunRow(row) : null;
  }

  findNextRunning(): AgentRun | null {
    const row = this.nextRunningStatement.get();
    return row ? mapRunRow(row) : null;
  }

  insertMany(runs: readonly AgentRun[]): void {
    for (const run of runs) {
      this.insertStatement.run(toRunParams(run));
    }
  }

  update(run: AgentRun): void {
    this.updateStatement.run(toRunParams(run));
  }

  deleteByIds(ids: readonly string[]): void {
    for (const id of ids) {
      this.deleteStatement.run(id);
    }
  }
}
