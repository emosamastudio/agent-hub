import type { SqliteDatabase } from "../db/index.js";
import type {
  ApprovalDecision,
  ApprovalItem,
  ApprovalPlatform,
  ApprovalState,
} from "../shared-types.js";

interface ApprovalRow {
  id: string;
  platform: ApprovalPlatform;
  state: ApprovalState;
  attention: ApprovalItem["attention"];
  agentId: string | null;
  runId: string | null;
  upstreamAgentId: string | null;
  sessionKey: string | null;
  host: string | null;
  nodeId: string | null;
  command: string;
  commandArgvJson: string | null;
  cwd: string | null;
  security: string | null;
  ask: string | null;
  resolvedPath: string | null;
  envKeysJson: string | null;
  systemRunPlanJson: string | null;
  systemRunBindingJson: string | null;
  createdAt: string;
  expiresAt: string | null;
  observedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  decision: ApprovalDecision | null;
  bridgeSessionId: string | null;
}

interface ApprovalRecordParams {
  id: string;
  platform: ApprovalPlatform;
  state: ApprovalState;
  attention: ApprovalItem["attention"];
  agentId: string | null;
  runId: string | null;
  upstreamAgentId: string | null;
  sessionKey: string | null;
  host: string | null;
  nodeId: string | null;
  command: string;
  commandArgvJson: string | null;
  cwd: string | null;
  security: string | null;
  ask: string | null;
  resolvedPath: string | null;
  envKeysJson: string | null;
  systemRunPlanJson: string | null;
  systemRunBindingJson: string | null;
  createdAt: string;
  expiresAt: string | null;
  observedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  decision: ApprovalDecision | null;
  bridgeSessionId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: string | null): string[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serializeStringArray(value: string[] | null | undefined): string | null {
  return Array.isArray(value) ? JSON.stringify(value) : null;
}

function serializeJsonRecord(
  value: Record<string, unknown> | null | undefined,
): string | null {
  return value ? JSON.stringify(value) : null;
}

function mapApprovalRow(row: ApprovalRow): ApprovalItem {
  return {
    id: row.id,
    platform: row.platform,
    state: row.state,
    attention: row.attention,
    agentId: row.agentId,
    runId: row.runId,
    upstreamAgentId: row.upstreamAgentId,
    sessionKey: row.sessionKey,
    host: row.host,
    nodeId: row.nodeId,
    request: {
      command: row.command,
      commandArgv: parseStringArray(row.commandArgvJson),
      cwd: row.cwd,
      host: row.host,
      nodeId: row.nodeId,
      security: row.security,
      ask: row.ask,
      agentId: row.upstreamAgentId,
      resolvedPath: row.resolvedPath,
      sessionKey: row.sessionKey,
      envKeys: parseStringArray(row.envKeysJson),
      systemRunPlan: parseJsonRecord(row.systemRunPlanJson),
      systemRunBinding: parseJsonRecord(row.systemRunBindingJson),
    },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    observedAt: row.observedAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    decision: row.decision,
    bridgeSessionId: row.bridgeSessionId,
  };
}

function toApprovalParams(approval: ApprovalItem): ApprovalRecordParams {
  return {
    id: approval.id,
    platform: approval.platform,
    state: approval.state,
    attention: approval.attention,
    agentId: approval.agentId ?? null,
    runId: approval.runId ?? null,
    upstreamAgentId: approval.upstreamAgentId ?? approval.request.agentId ?? null,
    sessionKey: approval.sessionKey ?? approval.request.sessionKey ?? null,
    host: approval.host ?? approval.request.host ?? null,
    nodeId: approval.nodeId ?? approval.request.nodeId ?? null,
    command: approval.request.command,
    commandArgvJson: serializeStringArray(approval.request.commandArgv),
    cwd: approval.request.cwd ?? null,
    security: approval.request.security ?? null,
    ask: approval.request.ask ?? null,
    resolvedPath: approval.request.resolvedPath ?? null,
    envKeysJson: serializeStringArray(approval.request.envKeys),
    systemRunPlanJson: serializeJsonRecord(approval.request.systemRunPlan),
    systemRunBindingJson: serializeJsonRecord(approval.request.systemRunBinding),
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt ?? null,
    observedAt: approval.observedAt,
    resolvedAt: approval.resolvedAt ?? null,
    resolvedBy: approval.resolvedBy ?? null,
    decision: approval.decision ?? null,
    bridgeSessionId: approval.bridgeSessionId ?? null,
  };
}

export class ApprovalRepository {
  private readonly listPendingStatement;
  private readonly getByIdStatement;
  private readonly upsertStatement;
  private readonly resolveStatement;
  private readonly expireStatement;
  private readonly markPendingStaleStatement;

  constructor(private readonly db: SqliteDatabase) {
    const selectClause = `
      SELECT
        id,
        platform,
        state,
        attention,
        agent_id AS agentId,
        run_id AS runId,
        upstream_agent_id AS upstreamAgentId,
        session_key AS sessionKey,
        host,
        node_id AS nodeId,
        command,
        command_argv_json AS commandArgvJson,
        cwd,
        security,
        ask,
        resolved_path AS resolvedPath,
        env_keys_json AS envKeysJson,
        system_run_plan_json AS systemRunPlanJson,
        system_run_binding_json AS systemRunBindingJson,
        created_at AS createdAt,
        expires_at AS expiresAt,
        observed_at AS observedAt,
        resolved_at AS resolvedAt,
        resolved_by AS resolvedBy,
        decision,
        bridge_session_id AS bridgeSessionId
      FROM approvals
    `;

    this.listPendingStatement = db.prepare<unknown[], ApprovalRow>(
      `${selectClause} WHERE state = 'pending' ORDER BY observed_at DESC, created_at DESC`,
    );
    this.getByIdStatement = db.prepare<[string], ApprovalRow>(
      `${selectClause} WHERE id = ?`,
    );
    this.upsertStatement = db.prepare<ApprovalRecordParams>(`
      INSERT INTO approvals (
        id,
        platform,
        state,
        attention,
        agent_id,
        run_id,
        upstream_agent_id,
        session_key,
        host,
        node_id,
        command,
        command_argv_json,
        cwd,
        security,
        ask,
        resolved_path,
        env_keys_json,
        system_run_plan_json,
        system_run_binding_json,
        created_at,
        expires_at,
        observed_at,
        resolved_at,
        resolved_by,
        decision,
        bridge_session_id
      ) VALUES (
        @id,
        @platform,
        @state,
        @attention,
        @agentId,
        @runId,
        @upstreamAgentId,
        @sessionKey,
        @host,
        @nodeId,
        @command,
        @commandArgvJson,
        @cwd,
        @security,
        @ask,
        @resolvedPath,
        @envKeysJson,
        @systemRunPlanJson,
        @systemRunBindingJson,
        @createdAt,
        @expiresAt,
        @observedAt,
        @resolvedAt,
        @resolvedBy,
        @decision,
        @bridgeSessionId
      )
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        state = excluded.state,
        attention = excluded.attention,
        agent_id = excluded.agent_id,
        run_id = excluded.run_id,
        upstream_agent_id = excluded.upstream_agent_id,
        session_key = excluded.session_key,
        host = excluded.host,
        node_id = excluded.node_id,
        command = excluded.command,
        command_argv_json = excluded.command_argv_json,
        cwd = excluded.cwd,
        security = excluded.security,
        ask = excluded.ask,
        resolved_path = excluded.resolved_path,
        env_keys_json = excluded.env_keys_json,
        system_run_plan_json = excluded.system_run_plan_json,
        system_run_binding_json = excluded.system_run_binding_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        observed_at = excluded.observed_at,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by,
        decision = excluded.decision,
        bridge_session_id = excluded.bridge_session_id
    `);
    this.resolveStatement = db.prepare<{
      id: string;
      attention: ApprovalItem["attention"];
      decision: ApprovalDecision;
      observedAt: string;
      resolvedAt: string;
      resolvedBy: string | null;
    }>(`
      UPDATE approvals
      SET
        state = 'resolved',
        attention = @attention,
        decision = @decision,
        observed_at = @observedAt,
        resolved_at = @resolvedAt,
        resolved_by = @resolvedBy
      WHERE id = @id
    `);
    this.expireStatement = db.prepare<{
      id: string;
      observedAt: string;
      resolvedAt: string;
    }>(`
      UPDATE approvals
      SET
        state = 'expired',
        attention = 'info',
        observed_at = @observedAt,
        resolved_at = @resolvedAt
      WHERE id = @id AND state = 'pending'
    `);
    this.markPendingStaleStatement = db.prepare<{
      platform: ApprovalPlatform;
      observedAt: string;
    }>(`
      UPDATE approvals
      SET
        state = 'stale',
        attention = 'info',
        observed_at = @observedAt
      WHERE platform = @platform AND state = 'pending'
    `);
  }

  listPending(): ApprovalItem[] {
    return this.listPendingStatement.all().map(mapApprovalRow);
  }

  getById(id: string): ApprovalItem | null {
    const row = this.getByIdStatement.get(id);
    return row ? mapApprovalRow(row) : null;
  }

  upsert(approval: ApprovalItem): void {
    this.upsertStatement.run(toApprovalParams(approval));
  }

  markResolved(
    id: string,
    decision: ApprovalDecision,
    resolvedBy: string | null,
    resolvedAt: string,
    observedAt: string,
  ): ApprovalItem | null {
    this.resolveStatement.run({
      id,
      attention: "info",
      decision,
      observedAt,
      resolvedAt,
      resolvedBy,
    });
    return this.getById(id);
  }

  markExpired(id: string, observedAt: string, resolvedAt: string): ApprovalItem | null {
    this.expireStatement.run({
      id,
      observedAt,
      resolvedAt,
    });
    return this.getById(id);
  }

  markPendingStale(platform: ApprovalPlatform, observedAt: string): void {
    this.markPendingStaleStatement.run({
      platform,
      observedAt,
    });
  }
}
