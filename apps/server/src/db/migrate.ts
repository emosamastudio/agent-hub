import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://agent_hub:agent_hub_dev@localhost:5433/agent_hub",
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
