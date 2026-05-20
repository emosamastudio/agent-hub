import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createMigrationConfig } from "./migration-config.js";

const migrationConfig = createMigrationConfig();

const pool = new pg.Pool({
  connectionString: migrationConfig.databaseUrl,
});

const db = drizzle(pool);

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
