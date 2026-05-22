import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const execFileAsync = promisify(execFile);

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

  test("provide a safe Docker Compose preflight script for target deployment", async () => {
    const scriptPath = resolve(repoRoot, "deploy/preflight-compose.sh");
    const script = await readFile(scriptPath, "utf8");
    await expect(execFileAsync("bash", ["-n", scriptPath])).resolves.toBeTruthy();
    const { stdout } = await execFileAsync("bash", [scriptPath, "--help"]);

    expect(stdout).toContain("--env-file");
    expect(stdout).toContain("--skip-image-pull");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("docker compose version");
    expect(script).toContain("AGENT_HUB_POSTGRES_PASSWORD");
    expect(script).toContain("AGENT_HUB_DASHBOARD_PASSWORD");
    expect(script).toContain("AGENT_HUB_DEFAULT_API_KEY");
    expect(script).toContain("replace-me");
    expect(script).toContain("agent_hub_dev_key");
    expect(script).toContain("127.0.0.1:${port}/api/ready");
    expect(script).toContain("node:22-bookworm-slim");
    expect(script).toContain("postgres:16-alpine");
    expect(script).not.toContain("echo \"$value\"");
  });

  test("provide a Docker Compose deployment script with readiness and release gates", async () => {
    const scriptPath = resolve(repoRoot, "deploy/deploy-compose.sh");
    const script = await readFile(scriptPath, "utf8");
    await expect(execFileAsync("bash", ["-n", scriptPath])).resolves.toBeTruthy();
    const { stdout } = await execFileAsync("bash", [scriptPath, "--help"]);

    expect(stdout).toContain("--release-check-project");
    expect(stdout).toContain("--skip-release-check");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("preflight-compose.sh");
    expect(script).toContain("docker compose");
    expect(script).toContain("up -d --build");
    expect(script).toContain("/api/ready");
    expect(script).toContain("ops release-check");
    expect(script).toContain("AGENT_HUB_API_KEY=\"${AGENT_HUB_API_KEY:-$AGENT_HUB_DEFAULT_API_KEY}\"");
    expect(script).toContain("docker compose logs --tail=100 agent-hub");
    expect(script).not.toContain("set -x");
  });
});
