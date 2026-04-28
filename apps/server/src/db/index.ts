import { mkdirSync } from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { seedDatabase } from "./seed.js";
import { applySchema } from "./schema.js";

export type SqliteDatabase = BetterSqlite3.Database;

interface CreateDatabaseOptions {
  dbPath: string;
  workspaceRoot: string;
}

export function createDatabase(options: CreateDatabaseOptions): SqliteDatabase {
  mkdirSync(path.dirname(options.dbPath), { recursive: true });

  const db = new BetterSqlite3(options.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  applySchema(db);
  seedDatabase(db, { workspaceRoot: options.workspaceRoot });

  return db;
}
