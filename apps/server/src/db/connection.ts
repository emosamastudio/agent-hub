import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

let pool: pg.Pool | null = null;

export function createPool(databaseUrl: string): pg.Pool {
  pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  return pool;
}

export function createDb(p: pg.Pool) {
  return drizzle(p);
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("Pool not initialized");
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
}
