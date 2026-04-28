import type { SqliteDatabase } from "../db/index.js";
import type { AgentEvent } from "../shared-types.js";

interface EventRecordParams extends AgentEvent {}

export class EventRepository {
  private readonly listStatement;
  private readonly insertStatement;

  constructor(private readonly db: SqliteDatabase) {
    this.listStatement = db.prepare<[number], AgentEvent>(`
      SELECT
        id,
        run_id AS runId,
        agent_id AS agentId,
        session_key AS sessionKey,
        project_id AS projectId,
        source_event_id AS sourceEventId,
        correlation_id AS correlationId,
        type,
        state,
        attention,
        message,
        created_at AS createdAt
      FROM events
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `);
    this.insertStatement = db.prepare<AgentEvent>(`
      INSERT INTO events (
        id,
        run_id,
        agent_id,
        session_key,
        project_id,
        source_event_id,
        correlation_id,
        type,
        state,
        attention,
        message,
        created_at
      ) VALUES (
        @id,
        @runId,
        @agentId,
        @sessionKey,
        @projectId,
        @sourceEventId,
        @correlationId,
        @type,
        @state,
        @attention,
        @message,
        @createdAt
      )
    `);
  }

  list(limit = 50): AgentEvent[] {
    return this.listStatement.all(limit);
  }

  insert(event: AgentEvent): void {
    this.insertStatement.run(toEventRecordParams(event));
  }

  insertMany(events: readonly AgentEvent[]): void {
    for (const event of events) {
      this.insertStatement.run(toEventRecordParams(event));
    }
  }
}

function toEventRecordParams(event: AgentEvent): EventRecordParams {
  return {
    ...event,
    sessionKey: event.sessionKey ?? null,
    projectId: event.projectId ?? null,
    sourceEventId: event.sourceEventId ?? null,
    correlationId: event.correlationId ?? null,
  };
}
