import type { SqliteDatabase } from "./index.js";

export function applySchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      state TEXT NOT NULL,
      health TEXT NOT NULL,
      attention TEXT NOT NULL,
      last_heartbeat_at TEXT,
      last_event_at TEXT,
      current_run_id TEXT,
      session_metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      health TEXT NOT NULL,
      attention TEXT NOT NULL,
      waiting_reason TEXT,
      progress_phase TEXT,
      progress_percent REAL,
      progress_message TEXT,
      last_event_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS inbox_entries (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      project_id TEXT,
      source_event_id TEXT,
      correlation_id TEXT,
      type TEXT NOT NULL,
      state TEXT,
      attention TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      state TEXT NOT NULL,
      attention TEXT NOT NULL,
      agent_id TEXT,
      run_id TEXT,
      upstream_agent_id TEXT,
      session_key TEXT,
      host TEXT,
      node_id TEXT,
      command TEXT NOT NULL,
      command_argv_json TEXT,
      cwd TEXT,
      security TEXT,
      ask TEXT,
      resolved_path TEXT,
      env_keys_json TEXT,
      system_run_plan_json TEXT,
      system_run_binding_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      observed_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      decision TEXT,
      bridge_session_id TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_assignments (
      run_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_priorities (
      run_id TEXT PRIMARY KEY,
      priority TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_handoffs (
      run_id TEXT PRIMARY KEY,
      target_owner TEXT NOT NULL,
      note TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS resource_policies (
      platform TEXT PRIMARY KEY,
      slot_limit INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

  `);

  ensureColumn(db, "agents", "session_metadata_json", "TEXT");
  ensureColumn(db, "events", "session_key", "TEXT");
  ensureColumn(db, "events", "project_id", "TEXT");
  ensureColumn(db, "events", "source_event_id", "TEXT");
  ensureColumn(db, "events", "correlation_id", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_agent_id ON runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
    CREATE INDEX IF NOT EXISTS idx_inbox_updated_at ON inbox_entries(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_agent_id ON events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_events_session_key ON events(session_key);
    CREATE INDEX IF NOT EXISTS idx_events_correlation_id ON events(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_state ON approvals(state);
    CREATE INDEX IF NOT EXISTS idx_approvals_observed_at ON approvals(observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_updated_at ON task_assignments(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_priorities_updated_at ON task_priorities(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_handoffs_updated_at ON task_handoffs(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_resource_policies_updated_at ON resource_policies(updated_at DESC);
  `);
}

interface TableInfoRow {
  name: string;
}

function ensureColumn(
  db: SqliteDatabase,
  tableName: "agents" | "runs" | "inbox_entries" | "events",
  columnName: string,
  columnDefinition: string,
): void {
  const existingColumns = db
    .prepare<unknown[], TableInfoRow>(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => row.name);

  if (existingColumns.includes(columnName)) {
    return;
  }

  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
  );
}
