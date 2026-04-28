import type { SqliteDatabase } from "../db/index.js";
import type {
  AgentDescriptor,
  AgentRuntimeActionTarget,
  AgentSessionMetadata,
} from "../shared-types.js";

interface CountRow {
  count: number;
}

interface AgentRow {
  id: string;
  name: string;
  platform: AgentDescriptor["platform"];
  workspacePath: string;
  state: AgentDescriptor["state"];
  health: AgentDescriptor["health"];
  attention: AgentDescriptor["attention"];
  lastHeartbeatAt: string | null;
  lastEventAt: string | null;
  currentRunId: string | null;
  sessionMetadataJson: string | null;
}

interface AgentRecordParams extends Omit<AgentRow, "sessionMetadataJson"> {
  sessionMetadataJson: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeRuntimeActionTargets(
  value: unknown,
): AgentRuntimeActionTarget[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = Array.from(
    new Set(
      value.filter(
        (entry): entry is AgentRuntimeActionTarget =>
          entry === "recover_gateway" ||
          entry === "reset_session" ||
          entry === "send_prompt",
      ),
    ),
  );

  return normalized.length > 0 ? normalized : null;
}

function normalizeUpstreamApprovalSupport(
  value: unknown,
): AgentSessionMetadata["upstreamApprovalSupport"] {
  if (!isRecord(value)) {
    return null;
  }

  const supported = toOptionalBoolean(value.supported);
  const code =
    value.code === "openclaw-acp-session" ||
    value.code === "openclaw-session-not-acp" ||
    value.code === "openclaw-session-unavailable"
      ? value.code
      : null;

  if (supported === null || code === null) {
    return null;
  }

  return {
    supported,
    code,
  };
}

function normalizeSessionMetadata(
  value: AgentSessionMetadata | Record<string, unknown> | null | undefined,
): AgentSessionMetadata | null {
  if (!value || !isRecord(value)) {
    return null;
  }

  const normalized: AgentSessionMetadata = {
    sessionId: toOptionalString(value.sessionId),
    sessionKey: toOptionalString(value.sessionKey),
    sessionPath: toOptionalString(value.sessionPath),
    gitRoot: toOptionalString(value.gitRoot),
    branch: toOptionalString(value.branch),
    summary: toOptionalString(value.summary),
    summaryCount: toOptionalNumber(value.summaryCount),
    startedAt: toOptionalString(value.startedAt),
    updatedAt: toOptionalString(value.updatedAt),
    toolVersion: toOptionalString(value.toolVersion),
    remoteSteerable: toOptionalBoolean(value.remoteSteerable),
    alreadyInUse: toOptionalBoolean(value.alreadyInUse),
    gatewayUrl: toOptionalString(value.gatewayUrl),
    gatewayReachable: toOptionalBoolean(value.gatewayReachable),
    gatewayError: toOptionalString(value.gatewayError),
    gatewayServiceInstalled: toOptionalBoolean(value.gatewayServiceInstalled),
    gatewayServiceLoaded: toOptionalBoolean(value.gatewayServiceLoaded),
    gatewayServiceLoadedText: toOptionalString(value.gatewayServiceLoadedText),
    runtimeActionEndpoint: toOptionalString(value.runtimeActionEndpoint),
    runtimeActionTargets: normalizeRuntimeActionTargets(
      value.runtimeActionTargets,
    ),
    upstreamApprovalSupport: normalizeUpstreamApprovalSupport(
      value.upstreamApprovalSupport,
    ),
  };

  return Object.values(normalized).some((entry) => entry !== null)
    ? normalized
    : null;
}

function parseSessionMetadata(
  value: string | null,
): AgentSessionMetadata | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return normalizeSessionMetadata(parsed);
  } catch {
    return null;
  }
}

function serializeSessionMetadata(
  value: AgentSessionMetadata | null | undefined,
): string | null {
  const normalized = normalizeSessionMetadata(value);
  return normalized ? JSON.stringify(normalized) : null;
}

function mapAgentRow(row: AgentRow): AgentDescriptor {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    workspacePath: row.workspacePath,
    state: row.state,
    health: row.health,
    attention: row.attention,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastEventAt: row.lastEventAt,
    currentRunId: row.currentRunId,
    sessionMetadata: parseSessionMetadata(row.sessionMetadataJson),
  };
}

function toAgentParams(agent: AgentDescriptor): AgentRecordParams {
  return {
    id: agent.id,
    name: agent.name,
    platform: agent.platform,
    workspacePath: agent.workspacePath,
    state: agent.state,
    health: agent.health,
    attention: agent.attention,
    lastHeartbeatAt: agent.lastHeartbeatAt,
    lastEventAt: agent.lastEventAt,
    currentRunId: agent.currentRunId,
    sessionMetadataJson: serializeSessionMetadata(agent.sessionMetadata),
  };
}

export class AgentRepository {
  private readonly listStatement;
  private readonly getByIdStatement;
  private readonly countStatement;
  private readonly insertStatement;
  private readonly updateStatement;
  private readonly heartbeatStatement;
  private readonly deleteStatement;

  constructor(private readonly db: SqliteDatabase) {
    const selectClause = `
      SELECT
        id,
        name,
        platform,
        workspace_path AS workspacePath,
        state,
        health,
        attention,
        last_heartbeat_at AS lastHeartbeatAt,
        last_event_at AS lastEventAt,
        current_run_id AS currentRunId,
        session_metadata_json AS sessionMetadataJson
      FROM agents
    `;

    this.listStatement = db.prepare<unknown[], AgentRow>(
      `${selectClause} ORDER BY name ASC`,
    );
    this.getByIdStatement = db.prepare<[string], AgentRow>(
      `${selectClause} WHERE id = ?`,
    );
    this.countStatement = db.prepare<unknown[], CountRow>(
      "SELECT COUNT(*) AS count FROM agents",
    );
    this.insertStatement = db.prepare<AgentRecordParams>(`
      INSERT INTO agents (
        id,
        name,
        platform,
        workspace_path,
        state,
        health,
        attention,
        last_heartbeat_at,
        last_event_at,
        current_run_id,
        session_metadata_json
      ) VALUES (
        @id,
        @name,
        @platform,
        @workspacePath,
        @state,
        @health,
        @attention,
        @lastHeartbeatAt,
        @lastEventAt,
        @currentRunId,
        @sessionMetadataJson
      )
    `);
    this.updateStatement = db.prepare<AgentRecordParams>(`
      UPDATE agents
      SET
        name = @name,
        platform = @platform,
        workspace_path = @workspacePath,
        state = @state,
        health = @health,
        attention = @attention,
        last_heartbeat_at = @lastHeartbeatAt,
        last_event_at = @lastEventAt,
        current_run_id = @currentRunId,
        session_metadata_json = @sessionMetadataJson
      WHERE id = @id
    `);
    this.heartbeatStatement = db.prepare<{
      id: string;
      lastHeartbeatAt: string;
      lastEventAt: string;
    }>(`
      UPDATE agents
      SET
        last_heartbeat_at = @lastHeartbeatAt,
        last_event_at = @lastEventAt
      WHERE id = @id
    `);
    this.deleteStatement = db.prepare<[string]>("DELETE FROM agents WHERE id = ?");
  }

  count(): number {
    return this.countStatement.get()?.count ?? 0;
  }

  list(): AgentDescriptor[] {
    return this.listStatement.all().map(mapAgentRow);
  }

  getById(id: string): AgentDescriptor | null {
    const row = this.getByIdStatement.get(id);
    return row ? mapAgentRow(row) : null;
  }

  insertMany(agents: readonly AgentDescriptor[]): void {
    for (const agent of agents) {
      this.insertStatement.run(toAgentParams(agent));
    }
  }

  update(agent: AgentDescriptor): void {
    this.updateStatement.run(toAgentParams(agent));
  }

  touchHeartbeat(id: string, timestamp: string): void {
    this.heartbeatStatement.run({
      id,
      lastHeartbeatAt: timestamp,
      lastEventAt: timestamp,
    });
  }

  deleteByIds(ids: readonly string[]): void {
    for (const id of ids) {
      this.deleteStatement.run(id);
    }
  }
}
