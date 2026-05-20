import { test } from "vitest";
import assert from "node:assert";
import { createMigrationConfig } from "../src/db/migration-config.js";

test("migration config uses the local development database by default", () => {
  const config = createMigrationConfig({});

  assert.equal(config.databaseUrl, "postgres://agent_hub:agent_hub_dev@localhost:5433/agent_hub");
});

test("migration config rejects production without an explicit database URL", () => {
  assert.throws(
    () => createMigrationConfig({ NODE_ENV: "production" }),
    /DATABASE_URL/,
  );
});

test("migration config accepts an explicit production database URL", () => {
  const config = createMigrationConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://agent_hub:secret@db.example.internal:5432/agent_hub",
  });

  assert.equal(config.databaseUrl, "postgres://agent_hub:secret@db.example.internal:5432/agent_hub");
});
