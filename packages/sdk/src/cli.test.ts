import { afterEach, describe, expect, test, vi } from "vitest";
import { buildControlConfig, parseCliInvocation, runCli } from "./cli";

describe("agent-hub CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("parses readiness checks", () => {
    expect(parseCliInvocation(["ready"])).toEqual({
      command: "ready",
    });
  });

  test("parses metrics checks", () => {
    expect(parseCliInvocation(["metrics"])).toEqual({
      command: "metrics",
    });
  });

  test("parses doctor diagnostics", () => {
    expect(parseCliInvocation(["doctor"])).toEqual({
      command: "doctor",
      options: {},
    });
    expect(parseCliInvocation(["doctor", "--project", "oph"])).toEqual({
      command: "doctor",
      options: {
        project: "oph",
      },
    });
  });

  test("parses ops status snapshots", () => {
    expect(parseCliInvocation([
      "ops",
      "status",
      "--project",
      "oph",
      "--alert-limit",
      "5",
      "--strict",
      "--fail-on-warning",
    ])).toEqual({
      command: "ops:status",
      options: {
        project: "oph",
        alertLimit: 5,
        strict: true,
        failOnWarning: true,
      },
    });
  });

  test("parses project drain invocations", () => {
    expect(parseCliInvocation(["projects", "drain", "oph"])).toEqual({
      command: "projects:drain",
      project: "oph",
      options: {
        cancelRunning: false,
      },
    });
    expect(parseCliInvocation(["projects", "drain", "project-1", "--cancel-running"])).toEqual({
      command: "projects:drain",
      project: "project-1",
      options: {
        cancelRunning: true,
      },
    });
  });

  test("parses project enable and disable invocations", () => {
    expect(parseCliInvocation(["projects", "enable", "oph"])).toEqual({
      command: "projects:set-enabled",
      project: "oph",
      enabled: true,
    });
    expect(parseCliInvocation(["projects", "disable", "project-1"])).toEqual({
      command: "projects:set-enabled",
      project: "project-1",
      enabled: false,
    });
  });

  test("parses trigger invocations with JSON payload and dedup options", () => {
    expect(parseCliInvocation([
      "trigger",
      "demo_agent",
      "--payload",
      "{\"value\":42}",
      "--idempotency-key",
      "manual-42",
      "--dedup-policy",
      "skip_if_exists",
    ])).toEqual({
      command: "trigger",
      agentName: "demo_agent",
      options: {
        payload: { value: 42 },
        idempotencyKey: "manual-42",
        dedupPolicy: "skip_if_exists",
      },
    });
  });

  test("parses trigger-and-wait invocations for canaries", () => {
    expect(parseCliInvocation([
      "trigger",
      "demo_agent",
      "--payload",
      "{\"value\":42}",
      "--wait",
      "--timeout-ms",
      "60000",
      "--interval-ms",
      "250",
      "--require-success",
    ])).toEqual({
      command: "trigger:wait",
      agentName: "demo_agent",
      triggerOptions: {
        payload: { value: 42 },
      },
      waitOptions: {
        timeoutMs: 60000,
        intervalMs: 250,
        requireSuccess: true,
      },
    });
  });

  test("parses one-step canary run invocations", () => {
    expect(parseCliInvocation([
      "canary",
      "run",
      "enrich_repo",
      "--project",
      "oph",
      "--payload",
      "{\"repo_name\":\"agent-hub-smoke\"}",
      "--timeout-ms",
      "600000",
    ])).toEqual({
      command: "canary:run",
      agentName: "enrich_repo",
      options: {
        project: "oph",
        payload: { repo_name: "agent-hub-smoke" },
        dedupPolicy: "allow_duplicate",
        timeoutMs: 600000,
        requireSuccess: true,
      },
    });
  });

  test("parses execution cancel and rerun invocations", () => {
    expect(parseCliInvocation(["executions", "inspect", "exec-1"])).toEqual({
      command: "executions:inspect",
      executionId: "exec-1",
    });
    expect(parseCliInvocation(["executions", "cancel", "exec-1"])).toEqual({
      command: "executions:cancel",
      executionId: "exec-1",
    });
    expect(parseCliInvocation(["executions", "rerun", "exec-1"])).toEqual({
      command: "executions:rerun",
      executionId: "exec-1",
    });
  });

  test("parses project-scoped execution list invocations", () => {
    expect(parseCliInvocation([
      "executions",
      "list",
      "--project",
      "oph",
      "--agent",
      "deep_research",
      "--status",
      "failed",
      "--limit",
      "10",
    ])).toEqual({
      command: "executions:list",
      query: {
        project: "oph",
        agent: "deep_research",
        status: "failed",
        limit: 10,
      },
    });
  });

  test("parses execution wait invocations", () => {
    expect(parseCliInvocation([
      "executions",
      "wait",
      "exec-1",
      "--timeout-ms",
      "60000",
      "--interval-ms",
      "250",
    ])).toEqual({
      command: "executions:wait",
      executionId: "exec-1",
      options: {
        timeoutMs: 60000,
        intervalMs: 250,
      },
    });
    expect(parseCliInvocation([
      "executions",
      "wait",
      "exec-1",
      "--require-success",
    ])).toEqual({
      command: "executions:wait",
      executionId: "exec-1",
      options: {
        requireSuccess: true,
      },
    });
  });

  test("parses scheduler status invocations", () => {
    expect(parseCliInvocation(["scheduler", "status", "--agent-id", "agent-1"])).toEqual({
      command: "scheduler:status",
      query: {
        agent_id: "agent-1",
      },
    });
  });

  test("parses executor and alert operations", () => {
    expect(parseCliInvocation(["executors", "list", "--project", "project-1"])).toEqual({
      command: "executors:list",
      query: {
        project: "project-1",
      },
    });
    expect(parseCliInvocation(["alerts", "list", "--limit", "5", "--include-acknowledged"])).toEqual({
      command: "alerts:list",
      query: {
        limit: 5,
        includeAcknowledged: true,
      },
    });
    expect(parseCliInvocation(["alerts", "acknowledge", "7", "--by", "agent"])).toEqual({
      command: "alerts:acknowledge",
      alertId: 7,
      options: {
        acknowledgedBy: "agent",
      },
    });
  });

  test("parses project API key operations", () => {
    expect(parseCliInvocation(["projects", "list"])).toEqual({
      command: "projects:list",
    });
    expect(parseCliInvocation([
      "projects",
      "ensure",
      "oph",
      "--display-name",
      "Open Source Project Hunter",
      "--description",
      "OPH executor integration",
    ])).toEqual({
      command: "projects:ensure",
      input: {
        name: "oph",
        displayName: "Open Source Project Hunter",
        description: "OPH executor integration",
      },
    });
    expect(parseCliInvocation([
      "projects",
      "create",
      "oph",
      "--display-name",
      "Open Source Project Hunter",
      "--description",
      "OPH executor integration",
    ])).toEqual({
      command: "projects:create",
      input: {
        name: "oph",
        displayName: "Open Source Project Hunter",
        description: "OPH executor integration",
      },
    });
    expect(parseCliInvocation(["projects", "rotate-key", "project-1"])).toEqual({
      command: "projects:rotate-key",
      projectId: "project-1",
    });
  });

  test("parses agent enable and disable invocations", () => {
    expect(parseCliInvocation(["agents", "enable", "agent-1"])).toEqual({
      command: "agents:set-enabled",
      agentId: "agent-1",
      enabled: true,
      options: {},
    });
    expect(parseCliInvocation(["agents", "disable", "deep_research", "--project", "oph"])).toEqual({
      command: "agents:set-enabled",
      agentId: "deep_research",
      enabled: false,
      options: {
        project: "oph",
      },
    });
  });

  test("parses dashboard agent create invocations", () => {
    expect(parseCliInvocation([
      "agents",
      "create",
      "demo_agent",
      "--display-name",
      "Demo Agent",
      "--description",
      "Runs the demo handler for manual operator validation.",
      "--type",
      "llm_agent",
      "--cron",
      "*/10 * * * *",
      "--handler",
      "demo_handler",
      "--concurrency",
      "2",
      "--timeout-seconds",
      "120",
      "--retry-max",
      "1",
      "--max-pending-queue",
      "25",
      "--labels",
      "{\"team\":\"ops\"}",
      "--disabled",
    ])).toEqual({
      command: "agents:create",
      input: {
        name: "demo_agent",
        displayName: "Demo Agent",
        description: "Runs the demo handler for manual operator validation.",
        agentType: "llm_agent",
        cronExpression: "*/10 * * * *",
        handlerName: "demo_handler",
        concurrency: 2,
        timeoutSeconds: 120,
        retryMax: 1,
        maxPendingQueue: 25,
        labels: { team: "ops" },
        enabled: false,
      },
    });
  });

  test("requires a description when creating an agent", () => {
    expect(() => parseCliInvocation([
      "agents",
      "create",
      "demo_agent",
      "--display-name",
      "Demo Agent",
    ])).toThrow("Usage: agent-hub agents create <agent-name> --display-name <name> --description <text>");
  });

  test("parses dashboard agent update invocations", () => {
    expect(parseCliInvocation([
      "agents",
      "update",
      "agent-1",
      "--display-name",
      "Renamed Agent",
      "--clear-cron",
      "--handler",
      "renamed_handler",
      "--retry-max",
      "0",
    ])).toEqual({
      command: "agents:update",
      agentId: "agent-1",
      options: {},
      patch: {
        displayName: "Renamed Agent",
        cronExpression: null,
        handlerName: "renamed_handler",
        retryMax: 0,
      },
    });
  });

  test("parses agent schedule preview invocations", () => {
    expect(parseCliInvocation([
      "agents",
      "schedule-preview",
      "deep_research",
      "--project",
      "oph",
      "--limit",
      "3",
    ])).toEqual({
      command: "agents:schedule-preview",
      agentId: "deep_research",
      options: {
        limit: 3,
        project: "oph",
      },
    });
  });

  test("parses archived agent listing and detail invocations", () => {
    expect(parseCliInvocation(["agents", "list", "--archived", "only"])).toEqual({
      command: "agents:list",
      query: {
        archived: "only",
      },
    });
    expect(parseCliInvocation(["agents", "get", "agent-1", "--include-archived"])).toEqual({
      command: "agents:get",
      agentId: "agent-1",
      options: {
        includeArchived: true,
      },
    });
  });

  test("parses dashboard agent delete invocations", () => {
    expect(parseCliInvocation(["agents", "delete", "deep_research", "--project", "oph"])).toEqual({
      command: "agents:delete",
      agentId: "deep_research",
      options: {
        project: "oph",
      },
    });
  });

  test("parses dashboard agent drain invocations", () => {
    expect(parseCliInvocation(["agents", "drain", "relationship_agent", "--project", "oph", "--cancel-running"])).toEqual({
      command: "agents:drain",
      agentId: "relationship_agent",
      options: {
        cancelRunning: true,
        project: "oph",
      },
    });
  });

  test("builds control config from agent-hub environment variables", () => {
    expect(buildControlConfig({
      AGENT_HUB_URL: "http://hub",
      AGENT_HUB_API_KEY: "dev-key",
      AGENT_HUB_DASHBOARD_USER: "root",
      AGENT_HUB_DASHBOARD_PASSWORD: "secret",
    })).toEqual({
      serverUrl: "http://hub",
      apiKey: "dev-key",
      dashboardUsername: "root",
      dashboardPassword: "secret",
    });
  });

  test("returns a non-zero exit code for strict failed ops status snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "http://hub/api/health") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/ready") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/metrics") return jsonResponse({ scheduler: { running: true } });
      if (url === "http://hub/api/projects") return jsonResponse([]);
      if (url === "http://hub/api/alerts?limit=20") return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const stdout = { text: "", write(chunk: string) { this.text += chunk; } };
    const stderr = { text: "", write(chunk: string) { this.text += chunk; } };

    await expect(runCli([
      "ops",
      "status",
      "--project",
      "oph",
      "--strict",
    ], {
      AGENT_HUB_URL: "http://hub",
      AGENT_HUB_DASHBOARD_USER: "admin",
      AGENT_HUB_DASHBOARD_PASSWORD: "secret",
      AGENT_HUB_API_KEY: "dev-key",
    }, { stdout, stderr })).resolves.toBe(1);

    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      project: {
        requested: "oph",
        found: false,
      },
    });
    expect(stderr.text).toContain("Agent Hub ops status failed");
  });

  test("returns a non-zero exit code when strict ops status treats warnings as failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "http://hub/api/health") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/ready") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/metrics") return jsonResponse({ scheduler: { running: true }, alerts_active: 1 });
      if (url === "http://hub/api/projects") {
        return jsonResponse([{ id: "project-1", name: "oph", displayName: "Open Source Project Hunter" }]);
      }
      if (url === "http://hub/api/agents?project=project-1") {
        return jsonResponse([{ id: "agent-1", name: "enrich_repo", executorStatus: "online" }]);
      }
      if (url === "http://hub/api/executors?project=project-1") {
        return jsonResponse([{ agent_name: "enrich_repo", executor_status: "online" }]);
      }
      if (url === "http://hub/api/alerts?limit=20") {
        return jsonResponse([{ id: 7, ruleName: "failed_runs", acknowledgedAt: null }]);
      }
      if (url === "http://hub/api/scheduler/status?project=project-1") {
        return jsonResponse({ runtime: { running: true }, agents: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const stdout = { text: "", write(chunk: string) { this.text += chunk; } };
    const stderr = { text: "", write(chunk: string) { this.text += chunk; } };

    await expect(runCli([
      "ops",
      "status",
      "--project",
      "oph",
      "--strict",
      "--fail-on-warning",
    ], {
      AGENT_HUB_URL: "http://hub",
      AGENT_HUB_DASHBOARD_USER: "admin",
      AGENT_HUB_DASHBOARD_PASSWORD: "secret",
      AGENT_HUB_API_KEY: "dev-key",
    }, { stdout, stderr })).resolves.toBe(1);

    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: false,
      summary: {
        errors: 0,
        warnings: 1,
      },
    });
    expect(stderr.text).toContain("Agent Hub ops status failed");
  });
});

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
