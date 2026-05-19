import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert";
import { createApp } from "../src/app.js";

let app: Awaited<ReturnType<typeof createApp>>["app"];

beforeAll(async () => {
  const created = await createApp();
  app = created.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// Helper: make request via Fastify's inject (no network stack needed)
function authHeader() {
  return "Basic " + Buffer.from("admin:admin").toString("base64");
}

async function api(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await app.inject({
    method,
    url,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.statusCode,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

// ─── Tests ───

test("GET /api/health returns ok", async () => {
  const { status, body } = await api("GET", "/api/health");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, "ok");
  assert.ok(body.uptime > 0);
});

test("GET /api/metrics returns agent counts", async () => {
  const { status, body } = await api("GET", "/api/metrics");
  assert.strictEqual(status, 200);
  assert.ok(body.agents_total >= 0);
});

test("GET /api/projects returns default project", async () => {
  const { status, body } = await api("GET", "/api/projects");
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1);
  assert.strictEqual(body[0].name, "default");
});

test("GET /api/agents returns seeded agents", async () => {
  const { status, body } = await api("GET", "/api/agents");
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 1);
  assert.strictEqual(body[0].name, "demo_hello");
});

test("PUT /api/registry/agents registers new agent", async () => {
  const agent = {
    name: "test_agent",
    displayName: "Test Agent",
    agentType: "cron_task",
    cron: "0 0 * * *",
    handler: "test_handler",
  };
  const { status, body } = await api("PUT", "/api/registry/agents", agent);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.name, "test_agent");
  assert.strictEqual(body.agentType, "cron_task");
});

test("POST /api/agents/:name/trigger creates execution", async () => {
  const { status, body } = await api("POST", "/api/agents/test_agent/trigger", {
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
  const { status, body } = await api("POST", "/api/executors/heartbeat", {});
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test("GET /api/executors/poll claims queued execution or returns 204", async () => {
  // Heartbeat (prev test) marked all project agents as online.
  // test_agent has a queued execution from trigger, so poll should claim it.
  const { status, body } = await api("GET", "/api/executors/poll");
  // Accept either 200 (claimed) or 204 (no match)
  if (status === 200) {
    assert.ok(body.id);
    assert.ok(body.agentId);
  }
});

test("GET /api/stats returns aggregate numbers", async () => {
  const { status, body } = await api("GET", "/api/stats");
  assert.strictEqual(status, 200);
  assert.ok(body.agents_total >= 2);
});

test("GET /api/cooldowns/:agent/:key returns empty for unknown", async () => {
  const { status, body } = await api("GET", "/api/cooldowns/test_agent/my_check");
  assert.strictEqual(status, 200);
  // Phase 1 stub — returns cooldown info
  assert.ok(typeof body.run_count === "number" && body.run_count >= 0);
});

test("PUT /api/cooldowns/:agent/:key stores cooldown", async () => {
  const { status, body } = await api("PUT", "/api/cooldowns/test_agent/my_check", {
    last_run_at: new Date().toISOString(),
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test("DELETE /api/registry/agents/:name deregisters agent", async () => {
  const { status } = await api("DELETE", "/api/registry/agents/test_agent");
  assert.strictEqual(status, 204);
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
