import type { SqliteDatabase } from "../db/index.js";
import type { AgentRun, WaitingReason } from "../shared-types.js";
import { mapRunRow, type RunRow } from "./run-repository.js";

export interface InboxEntry {
  id: string;
  runId: string;
  agentId: string;
  reason: WaitingReason;
  createdAt: string;
  updatedAt: string;
}

export class InboxRepository {
  private readonly listStatement;
  private readonly insertStatement;
  private readonly deleteStatement;

  constructor(private readonly db: SqliteDatabase) {
    this.listStatement = db.prepare<unknown[], RunRow>(`
      SELECT
        r.id,
        r.agent_id AS agentId,
        r.title,
        r.state,
        r.health,
        r.attention,
        r.waiting_reason AS waitingReason,
        r.progress_phase AS progressPhase,
        r.progress_percent AS progressPercent,
        r.progress_message AS progressMessage,
        r.last_event_at AS lastEventAt,
        r.created_at AS createdAt
      FROM inbox_entries AS i
      INNER JOIN runs AS r ON r.id = i.run_id
      ORDER BY i.updated_at DESC, r.last_event_at DESC
    `);
    this.insertStatement = db.prepare<InboxEntry>(`
      INSERT INTO inbox_entries (
        id,
        run_id,
        agent_id,
        reason,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @runId,
        @agentId,
        @reason,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(run_id) DO UPDATE SET
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = db.prepare<[string]>(
      "DELETE FROM inbox_entries WHERE run_id = ?",
    );
  }

  listRuns(): AgentRun[] {
    return this.listStatement.all().map(mapRunRow);
  }

  insertMany(entries: readonly InboxEntry[]): void {
    for (const entry of entries) {
      this.insertStatement.run(entry);
    }
  }

  upsert(entry: InboxEntry): void {
    this.insertStatement.run(entry);
  }

  deleteByRunId(runId: string): void {
    this.deleteStatement.run(runId);
  }
}
