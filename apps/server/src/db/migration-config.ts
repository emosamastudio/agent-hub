import { defaultDatabaseUrl } from "../config.js";

type Env = Record<string, string | undefined>;

export function createMigrationConfig(env: Env = process.env) {
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.DATABASE_URL ?? defaultDatabaseUrl;

  if (production && (!env.DATABASE_URL || databaseUrl === defaultDatabaseUrl)) {
    throw new Error("Production Agent Hub migrations require an explicit DATABASE_URL");
  }

  return {
    databaseUrl,
  } as const;
}
