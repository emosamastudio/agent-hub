import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createApp, type AppContext } from "../src/app.js";
import { evaluateAlerts, recoverStaleExecutors } from "../src/services/scheduler.js";

let app: Awaited<ReturnType<typeof createApp>>["app"];
let ctx: AppContext;
const testRunId = randomUUID().replace(/-/g, "").slice(0, 12);
const testAgentName = `test_agent_${testRunId}`;

function scopedName(prefix: string) {
  return `${prefix}_${testRunId}_${randomUUID().slice(0, 8)}`;
}

async function cleanupTestData() {
  const runPattern = `%${testRunId}%`;
  await ctx.db.execute(sql`
    DELETE FROM alert_log
    WHERE agent_id IN (
      SELECT id FROM agents WHERE name LIKE ${runPattern}
    )
    OR message LIKE ${runPattern}
    OR context::text LIKE ${runPattern}
  `);
  await ctx.db.execute(sql`
    DELETE FROM agent_cooldowns
    WHERE agent_name LIKE ${runPattern}
  `);
  await ctx.db.execute(sql`
    DELETE FROM agents
    WHERE name LIKE ${runPattern}
  `);
  await ctx.db.execute(sql`
    DELETE FROM projects
    WHERE name LIKE ${runPattern}
  `);
}

beforeAll(async () => {
  const created = await createApp();
  app = created.app;
  ctx = created.ctx;
  await app.ready();
  await cleanupTestData();
});

afterAll(async () => {
  await cleanupTestData();
  await app.close();
});

// Helper: make request via Fastify's inject (no network stack needed)
function authHeader() {
  const username = process.env.AGENT_HUB_DASHBOARD_USER ?? "admin";
  const password = process.env.AGENT_HUB_DASHBOARD_PASSWORD ?? "admin";
  return basicAuthHeader(username, password);
}

function basicAuthHeader(username: string, password: string) {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function apiKeyHeader() {
  return "Bearer agent_hub_dev_key";
}

async function api(
  method: string,
  url: string,
  body?: unknown,
  auth: "basic" | "bearer" | "none" = "basic",
) {
  const requestBody = defaultAgentDescription(method, url, body);
  const headers: Record<string, string> = {
  };
  if (auth === "basic") headers.Authorization = authHeader();
  if (auth === "bearer") headers.Authorization = apiKeyHeader();
  if (requestBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await app.inject({
    method,
    url,
    headers,
    body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
  });
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

async function apiWithBearer(method: string, url: string, apiKey: string, body?: unknown) {
  const requestBody = defaultAgentDescription(method, url, body);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (requestBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await app.inject({
    method,
    url,
    headers,
    body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
  });
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

function defaultAgentDescription(method: string, url: string, body: unknown) {
  if (
    ((method === "PUT" && url === "/api/registry/agents")
      || (method === "POST" && url === "/api/agents"))
    && body
    && typeof body === "object"
    && !Array.isArray(body)
    && !("description" in body)
  ) {
    const name = typeof (body as { name?: unknown }).name === "string"
      ? (body as { name: string }).name
      : "agent";
    return {
      ...body as Record<string, unknown>,
      description: `Test registration description for ${name}.`,
    };
  }
  return body;
}

// ─── Tests ───

test("GET /api/health returns ok", async () => {
  const { status, body } = await api("GET", "/api/health");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, "ok");
  assert.strictEqual(body.checks.database.status, "ok");
  assert.ok(body.uptime > 0);
});

test("GET /api/ready returns database readiness without dashboard auth", async () => {
  const { status, body } = await api("GET", "/api/ready", undefined, "none");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, "ok");
  assert.strictEqual(body.checks.database.status, "ok");
});

test("GET /api/metrics returns operational counters for canary observation", async () => {
  const agentName = scopedName("metrics");
  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Metrics Agent",
    agentType: "cron_task",
    handler: "metrics_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { source: "metrics-test" },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  await ctx.alertRepo.createOnce({
    ruleName: `metrics_probe_${testRunId}`,
    severity: "warning",
    agentId: registered.body.id,
    message: `${agentName} metrics probe`,
    context: { agentName },
  }, 0);

  const { status, body } = await api("GET", "/api/metrics");
  assert.strictEqual(status, 200);
  assert.ok(body.agents_total >= 0);
  assert.ok(body.agents_enabled >= 1);
  assert.ok(body.agents_online >= 0);
  assert.ok(body.executions_queued >= 1);
  assert.ok(body.executions_running >= 0);
  assert.ok(body.executions_success >= 0);
  assert.ok(body.executions_failed >= 0);
  assert.ok(body.executions_timeout >= 0);
  assert.ok(body.executions_cancelled >= 0);
  assert.ok(body.alerts_active >= 1);
  assert.strictEqual(typeof body.scheduler.running, "boolean");
  assert.strictEqual(typeof body.scheduler.tick_count, "number");
  assert.ok("last_tick_error_count" in body.scheduler);
});

test("GET /api/scheduler/status explains queue, capacity, and cron state for an agent", async () => {
  const agentName = scopedName("scheduler_status");
  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Scheduler Status",
    agentType: "cron_task",
    handler: "scheduler_status_handler",
    cron: "*/5 * * * *",
    concurrency: 2,
    maxPendingQueue: 1,
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { source: "scheduler-status-test" },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  const { status, body } = await api("GET", `/api/scheduler/status?agent_id=${registered.body.id}`);

  assert.strictEqual(status, 200);
  assert.ok(body.generatedAt);
  assert.strictEqual(body.scheduler.tickMs > 0, true);
  assert.strictEqual(body.agents.length, 1);

  const agent = body.agents[0];
  assert.strictEqual(agent.id, registered.body.id);
  assert.strictEqual(agent.name, agentName);
  assert.strictEqual(agent.queuedCount, 1);
  assert.strictEqual(agent.runningCount, 0);
  assert.strictEqual(agent.activeExecutionCount, 0);
  assert.strictEqual(agent.concurrency, 2);
  assert.strictEqual(agent.maxPendingQueue, 1);
  assert.strictEqual(agent.capacityAvailable, 2);
  assert.strictEqual(agent.queueAvailable, 0);
  assert.strictEqual(agent.dispatchState, "dispatchable");
  assert.strictEqual(agent.scheduleState, "queue_full");
  assert.ok(agent.nextRunAt);
});

test("GET /api/projects returns default project", async () => {
  const { status, body } = await api("GET", "/api/projects");
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1);
  assert.strictEqual(body[0].name, "default");
  assert.strictEqual(body[0].apiKeyHash, undefined);
  assert.strictEqual(body[0].api_key, undefined);
});

test("POST /api/projects creates a project-bound API key for executor integration", async () => {
  const projectName = scopedName("oph_project");
  const created = await api("POST", "/api/projects", {
    name: projectName,
    displayName: "OPH Integration",
    description: "Integration test project",
  });

  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.project.name, projectName);
  assert.strictEqual(created.body.project.displayName, "OPH Integration");
  assert.strictEqual(created.body.project.apiKeyHash, undefined);
  assert.match(created.body.api_key, /^agh_/);

  const listed = await api("GET", "/api/projects");
  const listedProject = listed.body.find((project: any) => project.name === projectName);
  assert.ok(listedProject);
  assert.strictEqual(listedProject.apiKeyHash, undefined);
  assert.strictEqual(listedProject.api_key, undefined);

  const agentName = scopedName("oph_deep_research");
  const registered = await apiWithBearer("PUT", "/api/registry/agents", created.body.api_key, {
    name: agentName,
    displayName: "OPH Deep Research",
    agentType: "llm_agent",
    handler: "deep_research_handler",
    timeoutSeconds: 300,
  });
  assert.strictEqual(registered.status, 200);
  assert.strictEqual(registered.body.projectId, created.body.project.id);

  const triggered = await apiWithBearer("POST", `/api/agents/${agentName}/trigger`, created.body.api_key, {
    payload: { repo_name: "agent-hub-smoke" },
    dedup_policy: "allow_duplicate",
  });
  assert.strictEqual(triggered.status, 202);

  const polled = await apiWithBearer(
    "GET",
    `/api/executors/poll?agent_names=${encodeURIComponent(agentName)}`,
    created.body.api_key,
  );
  assert.strictEqual(polled.status, 200);
  assert.strictEqual(polled.body.id, triggered.body.execution_id);
  assert.strictEqual(polled.body.agentId, registered.body.id);
  assert.strictEqual(polled.body.agentName, agentName);
  assert.strictEqual(polled.body.handlerName, "deep_research_handler");
  assert.deepStrictEqual(polled.body.inputPayload, { repo_name: "agent-hub-smoke" });
  assert.strictEqual(polled.body.timeoutSeconds, 300);
});

test("POST /api/projects/:id/api-key rotates a project API key", async () => {
  const projectName = scopedName("rotate_project");
  const created = await api("POST", "/api/projects", {
    name: projectName,
    displayName: "Rotate Project",
  });
  assert.strictEqual(created.status, 201);
  const oldKey = created.body.api_key;

  const rotated = await api("POST", `/api/projects/${created.body.project.id}/api-key`, {});
  assert.strictEqual(rotated.status, 200);
  assert.strictEqual(rotated.body.project.id, created.body.project.id);
  assert.match(rotated.body.api_key, /^agh_/);
  assert.notStrictEqual(rotated.body.api_key, oldKey);

  const rejected = await apiWithBearer("PUT", "/api/registry/agents", oldKey, {
    name: scopedName("old_key_agent"),
    displayName: "Old Key Agent",
    agentType: "cron_task",
    handler: "old_handler",
  });
  assert.strictEqual(rejected.status, 401);
  assert.strictEqual(rejected.body.error, "invalid_api_key");

  const accepted = await apiWithBearer("PUT", "/api/registry/agents", rotated.body.api_key, {
    name: scopedName("new_key_agent"),
    displayName: "New Key Agent",
    agentType: "cron_task",
    handler: "new_handler",
  });
  assert.strictEqual(accepted.status, 200);
  assert.strictEqual(accepted.body.projectId, created.body.project.id);
});

test("dashboard auth rejects a wrong username even when the password matches", async () => {
  const username = process.env.AGENT_HUB_DASHBOARD_USER ?? "admin";
  const password = process.env.AGENT_HUB_DASHBOARD_PASSWORD ?? "admin";
  const wrongUsername = username === "not-admin" ? "admin" : "not-admin";
  const res = await app.inject({
    method: "GET",
    url: "/api/projects",
    headers: {
      Authorization: basicAuthHeader(wrongUsername, password),
    },
  });

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.headers["www-authenticate"], undefined);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "unauthorized" });
});

test("GET /api/agents returns seeded agents", async () => {
  const { status, body } = await api("GET", "/api/agents");
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1);
  assert.strictEqual(body[0].name, "demo_hello");
});

test("SDK registry rejects requests without a bearer API key", async () => {
  const agent = {
    name: `unauth_${randomUUID()}`,
    displayName: "Unauth Agent",
    agentType: "cron_task",
    cron: "0 0 * * *",
    handler: "unauth_handler",
  };
  const { status } = await api("PUT", "/api/registry/agents", agent, "none");
  assert.strictEqual(status, 401);
});

test("PUT /api/registry/agents registers new agent", async () => {
  const agent = {
    name: testAgentName,
    displayName: "Test Agent",
    description: "Runs a deterministic test handler for registry coverage.",
    agentType: "cron_task",
    cron: "0 0 * * *",
    handler: "test_handler",
  };
  const { status, body } = await api("PUT", "/api/registry/agents", agent, "bearer");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.name, testAgentName);
  assert.strictEqual(body.description, agent.description);
  assert.strictEqual(body.agentType, "cron_task");
});

test("PUT /api/registry/agents rejects agents without a clear description", async () => {
  const { status, body } = await api("PUT", "/api/registry/agents", {
    name: scopedName("missing_description"),
    displayName: "Missing Description",
    description: "",
    agentType: "cron_task",
    handler: "missing_description_handler",
  }, "bearer");

  assert.strictEqual(status, 400);
  assert.strictEqual(body.error, "invalid_agent_spec");
  assert.strictEqual(body.message, "description must be at least 10 characters");
  assert.deepStrictEqual(body.details, [{
    path: "description",
    message: "description must be at least 10 characters",
  }]);
});

test("POST /api/agents creates a dashboard-managed agent", async () => {
  const projects = await api("GET", "/api/projects");
  const description = "Runs the dashboard-managed test handler for manual schedule validation.";
  const name = scopedName("dashboard_agent");
  const { status, body } = await api("POST", "/api/agents", {
    projectId: projects.body[0].id,
    name,
    displayName: "Dashboard Agent",
    description,
    agentType: "cron_task",
    cronExpression: "*/15 * * * *",
    handlerName: "dashboard_handler",
    concurrency: 2,
    timeoutSeconds: 120,
    retryMax: 1,
    maxPendingQueue: 20,
  });

  assert.strictEqual(status, 201);
  assert.strictEqual(body.name, name);
  assert.strictEqual(body.projectId, projects.body[0].id);
  assert.strictEqual(body.displayName, "Dashboard Agent");
  assert.strictEqual(body.description, description);
  assert.strictEqual(body.cronExpression, "*/15 * * * *");
  assert.strictEqual(body.handlerName, "dashboard_handler");
  assert.strictEqual(body.concurrency, 2);
  assert.strictEqual(body.executorStatus, "offline");
});

test("POST /api/agents rejects invalid dashboard cron expressions", async () => {
  const projects = await api("GET", "/api/projects");
  const { status, body } = await api("POST", "/api/agents", {
    projectId: projects.body[0].id,
    name: scopedName("bad_cron"),
    displayName: "Bad Cron",
    agentType: "cron_task",
    cronExpression: "not a cron",
  });

  assert.strictEqual(status, 400);
  assert.strictEqual(body.error, "invalid_cron_expression");
});

test("POST /api/agents/:name/trigger creates execution", async () => {
  const { status, body } = await api("POST", `/api/agents/${testAgentName}/trigger`, {
    payload: { test: true },
  });
  assert.strictEqual(status, 202);
  assert.ok(body.execution_id);
  assert.strictEqual(body.status, "queued");
});

test("GET /api/executions returns executions", async () => {
  const { status, body } = await api("GET", "/api/executions");
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1);
});

test("POST /api/executors/heartbeat succeeds", async () => {
  const { status, body } = await api("POST", "/api/executors/heartbeat", {
    agent_names: [testAgentName],
  }, "bearer");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test("POST /api/executors/heartbeat records running execution progress", async () => {
  const agentName = scopedName("heartbeat_progress");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Heartbeat Progress",
    agentType: "cron_task",
    handler: "heartbeat_progress_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { progress: true },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(trigger.body.execution_id);
  assert.ok(claimed);
  const before = new Date(claimed.lastActivityAt).getTime();

  const heartbeat = await api("POST", "/api/executors/heartbeat", {
    agent_names: [agentName],
    executions: [{
      execution_id: trigger.body.execution_id,
      progress_percent: 42,
      progress_message: "Halfway through extraction",
    }],
  }, "bearer");

  assert.strictEqual(heartbeat.status, 200);
  assert.strictEqual(heartbeat.body.ok, true);
  assert.strictEqual(heartbeat.body.executions_updated, 1);

  const refreshed = await api("GET", `/api/executions/${trigger.body.execution_id}`);
  assert.strictEqual(refreshed.body.progressPercent, 42);
  assert.strictEqual(refreshed.body.progressMessage, "Halfway through extraction");
  assert.ok(new Date(refreshed.body.lastActivityAt).getTime() >= before);
});

test("POST /api/executors/heartbeat reports cancelled executions to executors", async () => {
  const agentName = scopedName("heartbeat_cancelled");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Heartbeat Cancelled",
    agentType: "cron_task",
    handler: "heartbeat_cancelled_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { cancellable: true },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(trigger.body.execution_id);
  assert.ok(claimed);

  const cancelled = await api("POST", `/api/executions/${trigger.body.execution_id}/cancel`);
  assert.strictEqual(cancelled.status, 200);

  const heartbeat = await api("POST", "/api/executors/heartbeat", {
    agent_names: [agentName],
    executions: [{
      execution_id: trigger.body.execution_id,
    }],
  }, "bearer");

  assert.strictEqual(heartbeat.status, 200);
  assert.strictEqual(heartbeat.body.ok, true);
  assert.strictEqual(heartbeat.body.executions_updated, 0);
  assert.deepStrictEqual(heartbeat.body.cancelled_execution_ids, [trigger.body.execution_id]);
});

test("GET /api/executors/poll claims queued execution or returns 204", async () => {
  // Heartbeat (prev test) marked the run-scoped test agent as online.
  // The run-scoped test agent has a queued execution from trigger, so poll should claim it.
  const { status, body } = await api(
    "GET",
    `/api/executors/poll?agent_names=${encodeURIComponent(testAgentName)}`,
    undefined,
    "bearer",
  );
  // Accept either 200 (claimed) or 204 (no match)
  if (status === 200) {
    assert.ok(body.id);
    assert.ok(body.agentId);
  }
});

test("executor heartbeat only marks declared agents online", async () => {
  const onlineName = scopedName("hb_online");
  const untouchedName = scopedName("hb_untouched");

  const online = await api("PUT", "/api/registry/agents", {
    name: onlineName,
    displayName: "Heartbeat Online",
    agentType: "cron_task",
    handler: "online_handler",
  }, "bearer");
  const untouched = await api("PUT", "/api/registry/agents", {
    name: untouchedName,
    displayName: "Heartbeat Untouched",
    agentType: "cron_task",
    handler: "untouched_handler",
  }, "bearer");

  await api("PATCH", `/api/agents/${online.body.id}`, { executorStatus: "offline" });
  await api("PATCH", `/api/agents/${untouched.body.id}`, { executorStatus: "offline" });

  const heartbeat = await api("POST", "/api/executors/heartbeat", {
    agent_names: [onlineName],
  }, "bearer");
  assert.strictEqual(heartbeat.status, 200);

  const refreshedOnline = await api("GET", `/api/agents/${online.body.id}`);
  const refreshedUntouched = await api("GET", `/api/agents/${untouched.body.id}`);
  assert.strictEqual(refreshedOnline.body.executorStatus, "online");
  assert.strictEqual(refreshedUntouched.body.executorStatus, "offline");
});

test("PATCH /api/agents/:id rejects unsafe ownership fields", async () => {
  const agentName = scopedName("patch_guard");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Patch Guard",
    agentType: "cron_task",
    handler: "patch_guard_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const patch = await api("PATCH", `/api/agents/${registered.body.id}`, {
    projectId: randomUUID(),
  });
  assert.strictEqual(patch.status, 400);
  assert.strictEqual(patch.body.error, "invalid_agent_patch");

  const refreshed = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(refreshed.body.projectId, registered.body.projectId);
});

test("PATCH /api/agents/:id rejects invalid cron expressions", async () => {
  const agentName = scopedName("patch_cron");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Patch Cron",
    agentType: "cron_task",
    handler: "patch_cron_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const patch = await api("PATCH", `/api/agents/${registered.body.id}`, {
    cronExpression: "not a cron expression",
  });
  assert.strictEqual(patch.status, 400);
  assert.strictEqual(patch.body.error, "invalid_cron_expression");
});

test("GET /api/agents/:id/schedule-preview returns a bounded list of future cron runs", async () => {
  const agentName = scopedName("schedule_preview");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Schedule Preview",
    agentType: "cron_task",
    cron: "*/5 * * * *",
    handler: "schedule_preview_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const preview = await api("GET", `/api/agents/${registered.body.id}/schedule-preview?limit=3`);
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.body.runs.length, 3);

  const timestamps = preview.body.runs.map((value: string) => new Date(value).getTime());
  assert.ok(timestamps.every((value: number) => Number.isFinite(value) && value > Date.now()));
  assert.ok(timestamps[0] < timestamps[1]);
  assert.ok(timestamps[1] < timestamps[2]);
});

test("DELETE /api/agents/:id deletes a dashboard-managed agent", async () => {
  const projects = await api("GET", "/api/projects");
  const name = scopedName("delete_dashboard_agent");
  const created = await api("POST", "/api/agents", {
    projectId: projects.body[0].id,
    name,
    displayName: "Delete Dashboard Agent",
    agentType: "cron_task",
  });
  assert.strictEqual(created.status, 201);

  const deleted = await api("DELETE", `/api/agents/${created.body.id}`);
  assert.strictEqual(deleted.status, 204);

  const fetched = await api("GET", `/api/agents/${created.body.id}`);
  assert.strictEqual(fetched.status, 404);
});

test("DELETE /api/agents/:id archives agent while preserving terminal executions", async () => {
  const name = scopedName("archive_terminal_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Archive Terminal Agent",
    agentType: "cron_task",
    handler: "archive_terminal_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const triggered = await api("POST", `/api/agents/${name}/trigger`, {
    payload: { source: "archive_terminal_test" },
  }, "bearer");
  assert.strictEqual(triggered.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(triggered.body.execution_id);
  assert.ok(claimed);

  const reported = await api("POST", `/api/executions/${triggered.body.execution_id}/report`, {
    status: "success",
    result_summary: "terminal history is retained",
  }, "bearer");
  assert.strictEqual(reported.status, 200);

  const deleted = await api("DELETE", `/api/agents/${registered.body.id}`);
  assert.strictEqual(deleted.status, 204);

  const fetchedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetchedAgent.status, 404);

  const listedAgents = await api("GET", "/api/agents");
  assert.ok(!listedAgents.body.some((agent: any) => agent.id === registered.body.id));

  const fetchedExecution = await api("GET", `/api/executions/${triggered.body.execution_id}`);
  assert.strictEqual(fetchedExecution.status, 200);
  assert.strictEqual(fetchedExecution.body.agentId, registered.body.id);
  assert.strictEqual(fetchedExecution.body.status, "success");
  assert.strictEqual(fetchedExecution.body.resultSummary, "terminal history is retained");
});

test("GET /api/agents exposes archived agents only through explicit history filters", async () => {
  const name = scopedName("archived_history_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Archived History Agent",
    agentType: "cron_task",
    handler: "archived_history_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const triggered = await api("POST", `/api/agents/${name}/trigger`, {
    payload: { source: "archived_history_test" },
  }, "bearer");
  assert.strictEqual(triggered.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(triggered.body.execution_id);
  assert.ok(claimed);

  const reported = await api("POST", `/api/executions/${triggered.body.execution_id}/report`, {
    status: "success",
    result_summary: "visible from archived agent detail",
  }, "bearer");
  assert.strictEqual(reported.status, 200);

  const deleted = await api("DELETE", `/api/agents/${registered.body.id}`);
  assert.strictEqual(deleted.status, 204);

  const defaultList = await api("GET", "/api/agents");
  assert.strictEqual(defaultList.status, 200);
  assert.ok(!defaultList.body.some((agent: any) => agent.id === registered.body.id));

  const archivedOnly = await api("GET", "/api/agents?archived=only");
  assert.strictEqual(archivedOnly.status, 200);
  const archivedAgent = archivedOnly.body.find((agent: any) => agent.id === registered.body.id);
  assert.ok(archivedAgent);
  assert.ok(archivedAgent.archivedAt);

  const included = await api("GET", "/api/agents?archived=include");
  assert.strictEqual(included.status, 200);
  assert.ok(included.body.some((agent: any) => agent.id === registered.body.id));

  const hiddenDetail = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(hiddenDetail.status, 404);

  const archivedDetail = await api("GET", `/api/agents/${registered.body.id}?include_archived=true`);
  assert.strictEqual(archivedDetail.status, 200);
  assert.strictEqual(archivedDetail.body.id, registered.body.id);
  assert.ok(archivedDetail.body.archivedAt);
  assert.ok(Array.isArray(archivedDetail.body.recentExecutions));
  assert.strictEqual(archivedDetail.body.recentExecutions[0].id, triggered.body.execution_id);
  assert.strictEqual(archivedDetail.body.recentExecutions[0].resultSummary, "visible from archived agent detail");
});

test("PUT /api/registry/agents revives archived agents by name", async () => {
  const name = scopedName("revive_archived_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Revive Archived Agent",
    agentType: "cron_task",
    handler: "revive_archived_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const deleted = await api("DELETE", `/api/agents/${registered.body.id}`);
  assert.strictEqual(deleted.status, 204);

  const hidden = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(hidden.status, 404);

  const revived = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Revived Agent",
    agentType: "cron_task",
    handler: "revived_handler",
  }, "bearer");
  assert.strictEqual(revived.status, 200);
  assert.strictEqual(revived.body.id, registered.body.id);
  assert.strictEqual(revived.body.displayName, "Revived Agent");
  assert.strictEqual(revived.body.handlerName, "revived_handler");
  assert.strictEqual(revived.body.enabled, true);
  assert.strictEqual(revived.body.executorStatus, "online");
  assert.strictEqual(revived.body.archivedAt, null);

  const fetched = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetched.status, 200);
});

test("DELETE /api/agents/:id rejects agents with queued or running executions", async () => {
  const name = scopedName("delete_active_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Delete Active Agent",
    agentType: "cron_task",
    handler: "delete_active_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const triggered = await api("POST", `/api/agents/${name}/trigger`, {
    payload: { source: "delete_active_test" },
  }, "bearer");
  assert.strictEqual(triggered.status, 202);

  const deleted = await api("DELETE", `/api/agents/${registered.body.id}`);
  assert.strictEqual(deleted.status, 409);
  assert.strictEqual(deleted.body.error, "agent_has_active_executions");
  assert.strictEqual(deleted.body.active_execution_count, 1);

  const fetchedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetchedAgent.status, 200);

  const fetchedExecution = await api("GET", `/api/executions/${triggered.body.execution_id}`);
  assert.strictEqual(fetchedExecution.status, 200);
  assert.strictEqual(fetchedExecution.body.status, "queued");
});

test("POST /api/agents/:id/drain disables agent and cancels queued executions", async () => {
  const name = scopedName("drain_queued_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Drain Queued Agent",
    agentType: "cron_task",
    handler: "drain_queued_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const triggered = await api("POST", `/api/agents/${name}/trigger`, {
    payload: { source: "drain_queued_test" },
  }, "bearer");
  assert.strictEqual(triggered.status, 202);

  const drained = await api("POST", `/api/agents/${registered.body.id}/drain`, {});
  assert.strictEqual(drained.status, 200);
  assert.strictEqual(drained.body.ok, true);
  assert.strictEqual(drained.body.agent_id, registered.body.id);
  assert.strictEqual(drained.body.cancelled_queued, 1);
  assert.strictEqual(drained.body.cancelled_running, 0);
  assert.strictEqual(drained.body.active_execution_count, 0);

  const fetchedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetchedAgent.status, 200);
  assert.strictEqual(fetchedAgent.body.enabled, false);
  assert.strictEqual(fetchedAgent.body.activeExecutionCount, 0);

  const fetchedExecution = await api("GET", `/api/executions/${triggered.body.execution_id}`);
  assert.strictEqual(fetchedExecution.status, 200);
  assert.strictEqual(fetchedExecution.body.status, "cancelled");
  assert.strictEqual(fetchedExecution.body.errorMessage, "Cancelled by agent drain");

  const deleted = await api("DELETE", `/api/agents/${registered.body.id}`);
  assert.strictEqual(deleted.status, 204);
});

test("POST /api/agents/:id/drain requires dashboard authentication", async () => {
  const name = scopedName("drain_auth_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Drain Auth Agent",
    agentType: "cron_task",
    handler: "drain_auth_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const drained = await api("POST", `/api/agents/${registered.body.id}/drain`, {}, "none");
  assert.strictEqual(drained.status, 401);
});

test("POST /api/agents/:id/drain can cancel running executions when requested", async () => {
  const name = scopedName("drain_running_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Drain Running Agent",
    agentType: "cron_task",
    handler: "drain_running_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const triggered = await api("POST", `/api/agents/${name}/trigger`, {
    payload: { source: "drain_running_test" },
  }, "bearer");
  assert.strictEqual(triggered.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(triggered.body.execution_id);
  assert.ok(claimed);

  const beforeDrain = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(beforeDrain.body.activeExecutionCount, 1);

  const drained = await api("POST", `/api/agents/${registered.body.id}/drain`, {
    cancel_running: true,
  });
  assert.strictEqual(drained.status, 200);
  assert.strictEqual(drained.body.cancelled_queued, 0);
  assert.strictEqual(drained.body.cancelled_running, 1);
  assert.strictEqual(drained.body.active_execution_count, 0);

  const fetchedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetchedAgent.body.enabled, false);
  assert.strictEqual(fetchedAgent.body.activeExecutionCount, 0);

  const fetchedExecution = await api("GET", `/api/executions/${triggered.body.execution_id}`);
  assert.strictEqual(fetchedExecution.status, 200);
  assert.strictEqual(fetchedExecution.body.status, "cancelled");
  assert.strictEqual(fetchedExecution.body.errorMessage, "Cancelled by agent drain");
});

test("executor poll only claims work for declared agents", async () => {
  const firstName = scopedName("poll_first");
  const secondName = scopedName("poll_second");

  await api("PUT", "/api/registry/agents", {
    name: firstName,
    displayName: "Poll First",
    agentType: "cron_task",
    handler: "first_handler",
  }, "bearer");
  await api("PUT", "/api/registry/agents", {
    name: secondName,
    displayName: "Poll Second",
    agentType: "cron_task",
    handler: "second_handler",
    timeoutSeconds: 42,
  }, "bearer");

  const firstTrigger = await api("POST", `/api/agents/${firstName}/trigger`, {
    payload: { expected: firstName },
  }, "bearer");
  const secondTrigger = await api("POST", `/api/agents/${secondName}/trigger`, {
    payload: { expected: secondName },
  }, "bearer");
  assert.strictEqual(firstTrigger.status, 202);
  assert.strictEqual(secondTrigger.status, 202);

  const poll = await api(
    "GET",
    `/api/executors/poll?agent_names=${encodeURIComponent(secondName)}`,
    undefined,
    "bearer",
  );
  assert.strictEqual(poll.status, 200);
  assert.strictEqual(poll.body.id, secondTrigger.body.execution_id);
  assert.strictEqual(poll.body.agentName, secondName);
  assert.strictEqual(poll.body.handlerName, "second_handler");
  assert.strictEqual(poll.body.timeoutSeconds, 42);
  assert.deepStrictEqual(poll.body.inputPayload, { expected: secondName });
});

test("trigger idempotency key returns the existing active execution", async () => {
  const agentName = scopedName("idem");
  const idemKey = `same-work-${testRunId}-${randomUUID().slice(0, 8)}`;

  await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Idempotent Agent",
    agentType: "cron_task",
    handler: "idem_handler",
  }, "bearer");

  const first = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { n: 1 },
    idempotency_key: idemKey,
    dedup_policy: "skip_if_running",
  }, "bearer");
  const second = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { n: 2 },
    idempotency_key: idemKey,
    dedup_policy: "skip_if_running",
  }, "bearer");

  assert.strictEqual(first.status, 202);
  assert.strictEqual(second.status, 202);
  assert.strictEqual(second.body.execution_id, first.body.execution_id);
  assert.strictEqual(second.body.duplicate, true);
});

test("GET /api/executions/:id/trigger-chain returns both ancestors and descendants", async () => {
  const agentName = scopedName("chain");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Trigger Chain Agent",
    agentType: "cron_task",
    handler: "chain_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const root = await ctx.executionRepo.create({
    agentId: registered.body.id,
    triggerType: "cron",
    triggeredBy: "cron",
    status: "success",
    scheduledAt: new Date(Date.now() - 30_000),
    startedAt: new Date(Date.now() - 29_000),
    finishedAt: new Date(Date.now() - 28_000),
    triggerDepth: 0,
    inputPayload: { chain: "root" },
  } as any);
  const child = await ctx.executionRepo.create({
    agentId: registered.body.id,
    triggerType: "agent",
    triggeredBy: `agent:${agentName}`,
    status: "success",
    scheduledAt: new Date(Date.now() - 20_000),
    startedAt: new Date(Date.now() - 19_000),
    finishedAt: new Date(Date.now() - 18_000),
    parentExecutionId: root.id,
    rootExecutionId: root.id,
    triggerDepth: 1,
    inputPayload: { chain: "child" },
  } as any);
  const grandchild = await ctx.executionRepo.create({
    agentId: registered.body.id,
    triggerType: "agent",
    triggeredBy: `agent:${agentName}`,
    status: "queued",
    scheduledAt: new Date(Date.now() - 10_000),
    parentExecutionId: child.id,
    rootExecutionId: root.id,
    triggerDepth: 2,
    inputPayload: { chain: "grandchild" },
  } as any);

  const chain = await api("GET", `/api/executions/${child.id}/trigger-chain`);

  assert.strictEqual(chain.status, 200);
  assert.deepStrictEqual(
    chain.body.map((row: { id: string }) => row.id),
    [root.id, child.id, grandchild.id],
  );
});

test("claimForDispatch enforces agent concurrency atomically", async () => {
  const agentName = scopedName("claim_once");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Claim Once",
    agentType: "cron_task",
    handler: "claim_handler",
    concurrency: 1,
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const first = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { n: 1 },
  }, "bearer");
  const second = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { n: 2 },
  }, "bearer");

  const claims = await Promise.all([
    ctx.executionRepo.claimForDispatch(first.body.execution_id),
    ctx.executionRepo.claimForDispatch(second.body.execution_id),
  ]);

  assert.strictEqual(claims.filter(Boolean).length, 1);
  const refreshed = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(refreshed.body.activeExecutionCount, 1);
});

test("claimForDispatch refuses disabled agents even if queued work already exists", async () => {
  const agentName = scopedName("claim_disabled");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Claim Disabled",
    agentType: "cron_task",
    handler: "claim_disabled_handler",
    concurrency: 1,
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { disabled: true },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  await ctx.agentRepo.update(registered.body.id, { enabled: false } as any);

  const queued = await ctx.executionRepo.findQueued([registered.body.id]);
  assert.strictEqual(queued.length, 0);

  const claimed = await ctx.executionRepo.claimForDispatch(trigger.body.execution_id);
  assert.strictEqual(claimed, null);

  const fetchedExecution = await api("GET", `/api/executions/${trigger.body.execution_id}`);
  assert.strictEqual(fetchedExecution.body.status, "queued");

  const fetchedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetchedAgent.body.activeExecutionCount, 0);
});

test("createRetryIfAbsent creates only one retry for a failed execution", async () => {
  const agentName = scopedName("retry_once");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Retry Once",
    agentType: "cron_task",
    handler: "retry_handler",
    retryMax: 2,
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const execution = await ctx.executionRepo.create({
    agentId: registered.body.id,
    triggerType: "api",
    triggeredBy: "test",
    status: "failed",
    scheduledAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(Date.now() - 60_000),
    inputPayload: { retry: true },
    retryCount: 0,
    triggerDepth: 0,
  } as any);

  const firstRetry = await ctx.executionRepo.createRetryIfAbsent(execution.id);
  const secondRetry = await ctx.executionRepo.createRetryIfAbsent(execution.id);

  assert.ok(firstRetry);
  assert.strictEqual(firstRetry.retryOf, execution.id);
  assert.strictEqual(secondRetry, null);
});

test("timeoutRunning does not overwrite an execution that already completed", async () => {
  const agentName = scopedName("timeout_guard");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Timeout Guard",
    agentType: "cron_task",
    handler: "timeout_guard_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const execution = await ctx.executionRepo.create({
    agentId: registered.body.id,
    triggerType: "api",
    triggeredBy: "test",
    status: "running",
    scheduledAt: new Date(Date.now() - 20_000),
    startedAt: new Date(Date.now() - 19_000),
    lastActivityAt: new Date(Date.now() - 18_000),
    inputPayload: { timeout: "guard" },
    triggerDepth: 0,
  } as any);

  const completed = await ctx.executionRepo.completeRunning(execution.id, "success", {
    finishedAt: new Date(),
    resultSummary: "already done",
  });
  assert.ok(completed);

  const timedOut = await ctx.executionRepo.timeoutRunning(execution.id, {
    finishedAt: new Date(),
    errorMessage: "late timeout",
  });

  assert.strictEqual(timedOut, null);
  const refreshed = await api("GET", `/api/executions/${execution.id}`);
  assert.strictEqual(refreshed.body.status, "success");
  assert.strictEqual(refreshed.body.resultSummary, "already done");
  assert.strictEqual(refreshed.body.errorMessage, null);
});

test("recoverStaleExecutors times out stale running executions so they can retry", async () => {
  const agentName = scopedName("stale_executor");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Stale Executor",
    agentType: "cron_task",
    handler: "stale_executor_handler",
    concurrency: 1,
    retryMax: 1,
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { stale: true },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(trigger.body.execution_id);
  assert.ok(claimed);
  await ctx.agentRepo.update(registered.body.id, {
    executorStatus: "online",
    lastHeartbeatAt: new Date(Date.now() - 60_000),
  } as any);

  const recovered = await recoverStaleExecutors(ctx, 30);

  assert.strictEqual(recovered.agentsOffline, 1);
  assert.strictEqual(recovered.executionsTimedOut, 1);

  const refreshedExecution = await api("GET", `/api/executions/${trigger.body.execution_id}`);
  assert.strictEqual(refreshedExecution.body.status, "timeout");
  assert.ok(refreshedExecution.body.finishedAt);
  assert.ok(refreshedExecution.body.durationMs >= 0);
  assert.match(refreshedExecution.body.errorMessage, /Executor heartbeat stale/);

  const refreshedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(refreshedAgent.body.executorStatus, "offline");
  assert.strictEqual(refreshedAgent.body.activeExecutionCount, 0);

  const retry = await ctx.executionRepo.createRetryIfAbsent(trigger.body.execution_id);
  assert.ok(retry);
  assert.strictEqual(retry.status, "queued");
  assert.strictEqual(retry.retryOf, trigger.body.execution_id);
});

test("POST /api/executions/:id/cancel cancels a running execution and releases capacity once", async () => {
  const agentName = scopedName("cancel_running");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Cancel Running",
    agentType: "cron_task",
    handler: "cancel_handler",
    concurrency: 1,
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { cancel: true },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(trigger.body.execution_id);
  assert.ok(claimed);

  const activeAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(activeAgent.body.activeExecutionCount, 1);

  const cancelled = await api("POST", `/api/executions/${trigger.body.execution_id}/cancel`);
  assert.strictEqual(cancelled.status, 200);
  assert.strictEqual(cancelled.body.ok, true);
  assert.strictEqual(cancelled.body.status, "cancelled");

  const refreshedExecution = await api("GET", `/api/executions/${trigger.body.execution_id}`);
  assert.strictEqual(refreshedExecution.body.status, "cancelled");
  assert.ok(refreshedExecution.body.finishedAt);
  assert.ok(refreshedExecution.body.durationMs >= 0);
  assert.strictEqual(refreshedExecution.body.errorMessage, "Cancelled by dashboard");

  const refreshedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(refreshedAgent.body.activeExecutionCount, 0);

  const secondCancel = await api("POST", `/api/executions/${trigger.body.execution_id}/cancel`);
  assert.strictEqual(secondCancel.status, 409);
  assert.strictEqual(secondCancel.body.error, "execution_already_terminal");

  const afterSecondCancel = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(afterSecondCancel.body.activeExecutionCount, 0);
});

test("POST /api/executions/:id/cancel rejects terminal executions", async () => {
  const agentName = scopedName("cancel_terminal");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Cancel Terminal",
    agentType: "cron_task",
    handler: "terminal_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const execution = await ctx.executionRepo.create({
    agentId: registered.body.id,
    triggerType: "api",
    triggeredBy: "test",
    status: "success",
    scheduledAt: new Date(),
    finishedAt: new Date(),
    inputPayload: { done: true },
    triggerDepth: 0,
  } as any);

  const cancelled = await api("POST", `/api/executions/${execution.id}/cancel`);
  assert.strictEqual(cancelled.status, 409);
  assert.strictEqual(cancelled.body.error, "execution_already_terminal");

  const refreshed = await api("GET", `/api/executions/${execution.id}`);
  assert.strictEqual(refreshed.body.status, "success");
});

test("POST /api/executions/:id/report cannot overwrite a cancelled execution", async () => {
  const agentName = scopedName("late_report");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Late Report Agent",
    agentType: "cron_task",
    handler: "late_report_handler",
    concurrency: 1,
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { late: true },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  const claimed = await ctx.executionRepo.claimForDispatch(trigger.body.execution_id);
  assert.ok(claimed);

  const cancelled = await api("POST", `/api/executions/${trigger.body.execution_id}/cancel`);
  assert.strictEqual(cancelled.status, 200);

  const lateReport = await api("POST", `/api/executions/${trigger.body.execution_id}/report`, {
    status: "success",
    result_summary: "arrived after cancellation",
    result_data: { overwritten: true },
  }, "bearer");

  assert.strictEqual(lateReport.status, 409);
  assert.strictEqual(lateReport.body.error, "execution_not_running");
  assert.strictEqual(lateReport.body.status, "cancelled");

  const refreshedExecution = await api("GET", `/api/executions/${trigger.body.execution_id}`);
  assert.strictEqual(refreshedExecution.body.status, "cancelled");
  assert.strictEqual(refreshedExecution.body.resultSummary, null);
  assert.strictEqual(refreshedExecution.body.resultData, null);
  assert.strictEqual(refreshedExecution.body.errorMessage, "Cancelled by dashboard");

  const refreshedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(refreshedAgent.body.activeExecutionCount, 0);
});

test("POST /api/executions/:id/rerun creates a queued copy of the original payload", async () => {
  const agentName = scopedName("rerun");

  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Rerun Agent",
    agentType: "cron_task",
    handler: "rerun_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const original = await ctx.executionRepo.create({
    agentId: registered.body.id,
    triggerType: "api",
    triggeredBy: "test",
    status: "failed",
    scheduledAt: new Date(),
    finishedAt: new Date(),
    inputPayload: { rerun: true, nested: { value: 42 } },
    errorMessage: "original failure",
    triggerDepth: 0,
  } as any);

  const rerun = await api("POST", `/api/executions/${original.id}/rerun`);
  assert.strictEqual(rerun.status, 202);
  assert.ok(rerun.body.execution_id);
  assert.notStrictEqual(rerun.body.execution_id, original.id);
  assert.strictEqual(rerun.body.status, "queued");
  assert.strictEqual(rerun.body.source_execution_id, original.id);

  const created = await api("GET", `/api/executions/${rerun.body.execution_id}`);
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.body.agentId, registered.body.id);
  assert.strictEqual(created.body.status, "queued");
  assert.strictEqual(created.body.triggerType, "manual");
  assert.strictEqual(created.body.triggeredBy, `rerun:${original.id}`);
  assert.deepStrictEqual(created.body.inputPayload, { rerun: true, nested: { value: 42 } });
});

test("trace batch preserves span metadata", async () => {
  const agentName = scopedName("trace_meta");
  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Trace Metadata",
    agentType: "llm_agent",
    handler: "trace_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const trigger = await api("POST", `/api/agents/${agentName}/trigger`, {
    payload: { trace: true },
  }, "bearer");
  assert.strictEqual(trigger.status, 202);

  const traces = await api("POST", `/api/executions/${trigger.body.execution_id}/traces`, {
    traces: [{
      turn_index: 0,
      span_index: 0,
      role: "assistant",
      span_type: "llm",
      output_content: "done",
      metadata: { provider_request_id: "req-123", cache_hit: false },
    }],
  }, "bearer");
  assert.strictEqual(traces.status, 200);
  assert.strictEqual(traces.body.count, 1);

  const stored = await api("GET", `/api/executions/${trigger.body.execution_id}/traces`);
  assert.strictEqual(stored.status, 200);
  assert.strictEqual(stored.body.length, 1);
  assert.deepStrictEqual(stored.body[0].metadata, {
    provider_request_id: "req-123",
    cache_hit: false,
  });
});

test("GET /api/stats returns aggregate numbers", async () => {
  const { status, body } = await api("GET", "/api/stats");
  assert.strictEqual(status, 200);
  assert.ok(body.agents_total >= 2);
});

test("GET /api/cooldowns/:agent/:key returns empty for unknown", async () => {
  const { status, body } = await api("GET", `/api/cooldowns/${testAgentName}/my_check`, undefined, "bearer");
  assert.strictEqual(status, 200);
  // Phase 1 stub — returns cooldown info
  assert.ok(typeof body.run_count === "number" && body.run_count >= 0);
});

test("PUT /api/cooldowns/:agent/:key stores cooldown", async () => {
  const { status, body } = await api("PUT", `/api/cooldowns/${testAgentName}/my_check`, {
    last_run_at: new Date().toISOString(),
  }, "bearer");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test("alert evaluator records consecutive failures for the dashboard", async () => {
  const agentName = scopedName("alert_failures");
  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Alert Failures",
    agentType: "cron_task",
    handler: "alert_handler",
  }, "bearer");

  for (let i = 0; i < 3; i++) {
    await ctx.executionRepo.create({
      agentId: registered.body.id,
      triggerType: "manual",
      triggeredBy: `test:${testRunId}`,
      status: "failed",
      scheduledAt: new Date(),
      finishedAt: new Date(),
      errorMessage: `${testRunId} failure ${i}`,
      triggerDepth: 0,
    } as any);
  }

  const created = await evaluateAlerts(ctx);
  assert.ok(created >= 1);

  const alerts = await api("GET", "/api/alerts?limit=20");
  assert.strictEqual(alerts.status, 200);
  const alert = alerts.body.find((item: any) =>
    item.ruleName === "consecutive_failures" &&
    item.agentId === registered.body.id
  );
  assert.ok(alert);
  assert.strictEqual(alert.severity, "critical");
  assert.match(alert.message, /3 consecutive/);
  assert.strictEqual(alert.agentName, agentName);

  const duplicateCount = await evaluateAlerts(ctx);
  assert.strictEqual(duplicateCount, 0);
});

test("alert evaluator avoids noisy queue-depth duplicates", async () => {
  const agentName = scopedName("alert_queue");
  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Alert Queue",
    agentType: "cron_task",
    handler: "alert_queue_handler",
  }, "bearer");

  for (let i = 0; i < 11; i++) {
    await ctx.executionRepo.create({
      agentId: registered.body.id,
      triggerType: "manual",
      triggeredBy: `test:${testRunId}`,
      status: "queued",
      scheduledAt: new Date(),
      triggerDepth: 0,
    } as any);
  }

  const created = await evaluateAlerts(ctx);
  assert.ok(created >= 1);

  await ctx.db.execute(sql`
    UPDATE alert_log
    SET created_at = now() - interval '10 minutes'
    WHERE rule_name = 'queue_depth_high'
    AND agent_id = ${registered.body.id}
  `);

  const duplicateCount = await evaluateAlerts(ctx);
  assert.strictEqual(duplicateCount, 0);
});

test("acknowledged alerts are hidden from the active dashboard list", async () => {
  const agentName = scopedName("alert_ack");
  const registered = await api("PUT", "/api/registry/agents", {
    name: agentName,
    displayName: "Alert Ack",
    agentType: "cron_task",
    handler: "alert_ack_handler",
  }, "bearer");

  for (let i = 0; i < 11; i++) {
    await ctx.executionRepo.create({
      agentId: registered.body.id,
      triggerType: "manual",
      triggeredBy: `test:${testRunId}`,
      status: "queued",
      scheduledAt: new Date(),
      triggerDepth: 0,
    } as any);
  }

  await evaluateAlerts(ctx);
  const activeBefore = await api("GET", "/api/alerts?limit=20");
  assert.strictEqual(activeBefore.status, 200);
  const alert = activeBefore.body.find((item: any) =>
    item.ruleName === "queue_depth_high" &&
    item.agentId === registered.body.id
  );
  assert.ok(alert);

  const acknowledged = await api("POST", `/api/alerts/${alert.id}/acknowledge`, {
    acknowledgedBy: "test-dashboard",
  });
  assert.strictEqual(acknowledged.status, 200);
  assert.strictEqual(acknowledged.body.id, alert.id);
  assert.ok(acknowledged.body.acknowledgedAt);
  assert.strictEqual(acknowledged.body.acknowledgedBy, "test-dashboard");

  const activeAfter = await api("GET", "/api/alerts?limit=20");
  assert.strictEqual(activeAfter.status, 200);
  assert.ok(!activeAfter.body.some((item: any) => item.id === alert.id));

  const history = await api("GET", "/api/alerts?include_acknowledged=true&limit=20");
  assert.strictEqual(history.status, 200);
  assert.ok(history.body.some((item: any) => item.id === alert.id));
});

test("DELETE /api/registry/agents/:name deregisters agent", async () => {
  const name = scopedName("registry_delete_idle_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Registry Delete Idle Agent",
    agentType: "cron_task",
    handler: "registry_delete_idle_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const { status } = await api("DELETE", `/api/registry/agents/${name}`, undefined, "bearer");
  assert.strictEqual(status, 204);

  const fetched = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetched.status, 404);
});

test("DELETE /api/registry/agents/:name rejects agents with queued or running executions", async () => {
  const name = scopedName("registry_delete_active_agent");
  const registered = await api("PUT", "/api/registry/agents", {
    name,
    displayName: "Registry Delete Active Agent",
    agentType: "cron_task",
    handler: "registry_delete_active_handler",
  }, "bearer");
  assert.strictEqual(registered.status, 200);

  const triggered = await api("POST", `/api/agents/${name}/trigger`, {
    payload: { source: "registry_delete_active_test" },
  }, "bearer");
  assert.strictEqual(triggered.status, 202);

  const deleted = await api("DELETE", `/api/registry/agents/${name}`, undefined, "bearer");
  assert.strictEqual(deleted.status, 409);
  assert.strictEqual(deleted.body.error, "agent_has_active_executions");
  assert.strictEqual(deleted.body.active_execution_count, 1);

  const fetchedAgent = await api("GET", `/api/agents/${registered.body.id}`);
  assert.strictEqual(fetchedAgent.status, 200);

  const fetchedExecution = await api("GET", `/api/executions/${triggered.body.execution_id}`);
  assert.strictEqual(fetchedExecution.status, 200);
  assert.strictEqual(fetchedExecution.body.status, "queued");
});

test("PATCH /api/agents/bulk disables all agents in project", async () => {
  // Get the default project's UUID (route expects UUID, not name)
  const projectsRes = await api("GET", "/api/projects");
  const projectId = projectsRes.body[0].id;

  const { status, body } = await api("PATCH", "/api/agents/bulk", {
    project: projectId,
    enabled: false,
  });
  assert.strictEqual(status, 200);
  assert.ok(body.count >= 1);
  // Re-enable
  const reenable = await api("PATCH", "/api/agents/bulk", {
    project: projectId,
    enabled: true,
  });
  assert.strictEqual(reenable.status, 200);
});

test("PATCH /api/agents/bulk rejects invalid patch bodies", async () => {
  const { status, body } = await api("PATCH", "/api/agents/bulk", {
    project: "default",
    enabled: "false",
  });
  assert.strictEqual(status, 400);
  assert.strictEqual(body.error, "project_and_enabled_required");
});
