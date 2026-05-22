import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

describe("production deployment assets", () => {
  test("provide a Docker image for hosts without a modern Node runtime", async () => {
    const dockerfile = await readFile(resolve(repoRoot, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("FROM node:22-bookworm-slim");
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toContain("npm run start -w @agent-hub/server");
    expect(dockerfile).toContain("EXPOSE 8788");
  });

  test("provide a production compose file with database, migration, health, and env wiring", async () => {
    const compose = await readFile(resolve(repoRoot, "deploy/docker-compose.production.yml"), "utf8");

    expect(compose).toContain("postgres:16-alpine");
    expect(compose).toContain("/etc/agent-hub/agent-hub.env");
    expect(compose).toContain("DATABASE_URL: postgres://agent_hub:");
    expect(compose).toContain("@postgres:5432/agent_hub");
    expect(compose).toContain("npm run db:migrate -w @agent-hub/server");
    expect(compose).toContain("npm run start -w @agent-hub/server");
    expect(compose).toContain("\"8788:8788\"");
    expect(compose).toContain("agent-hub-postgres-data");
    expect(compose).toContain("http://127.0.0.1:8788/api/ready");
  });
});
