import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentHubClient, AgentHubControlClient } from "./index";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const directAgentId = "11111111-1111-4111-8111-111111111111";

describe("AgentHubClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("runOnce polls one execution, invokes the handler, and reports success", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: { value: 42 },
        });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async (ctx) => ({
      accepted: true,
      value: ctx.payload.value,
    }));

    await expect(client.runOnce()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0].init?.headers).toMatchObject({
      Authorization: "Bearer dev-key",
      "Agent-Hub-Version": "1",
    });
    expect(JSON.parse(requests[1].init?.body as string)).toMatchObject({
      status: "success",
      result_data: { accepted: true, value: 42 },
      trace_count_expected: 0,
    });
  });

  test("runOnce uses the claimed execution timeout", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
          timeoutSeconds: 7,
        });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async () => ({ done: true }));

    await expect(client.runOnce()).resolves.toBe(true);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 7_000);
  });

  test("runOnce returns false when no work is available", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });

    await expect(client.runOnce()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("syncRegistry registers all configured agents", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/registry/agents");
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer dev-key",
        "Agent-Hub-Version": "1",
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        name: "demo_agent",
        displayName: "Demo Agent",
        description: "Runs the demo handler for SDK registry synchronization.",
        agentType: "cron_task",
        handler: "demo_handler",
        cron: "*/5 * * * *",
      });
      return jsonResponse({ id: "agent-1", name: "demo_agent" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK registry synchronization.",
      agentType: "cron_task",
      handler: "demo_handler",
      cron: "*/5 * * * *",
    });
    client.handle("demo_handler", async () => ({ ok: true }));

    await expect(client.syncRegistry()).resolves.toEqual([{ id: "agent-1", name: "demo_agent" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("syncRegistry rejects agents without matching local handlers before registration", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "agent-1", name: "demo_agent" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK registry synchronization.",
      agentType: "cron_task",
      handler: "demo_handler",
    });

    await expect(client.syncRegistry()).rejects.toThrow(
      "Agent Hub handler demo_handler is not registered for agent demo_agent",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("runOnce reports failed when the handler throws", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async () => {
      throw new Error("boom");
    });

    await expect(client.runOnce()).resolves.toBe(true);

    expect(JSON.parse(requests[1].init?.body as string)).toMatchObject({
      status: "failed",
      error_message: "boom",
      trace_count_expected: 0,
    });
  });

  test("log records execution trace spans before reporting", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://hub/api/executions/exec-1/traces") {
        return jsonResponse({ ok: true, count: 1 });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async (ctx) => {
      await ctx.log("Loaded 12 records");
      return { done: true };
    });

    await expect(client.runOnce()).resolves.toBe(true);

    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/executors/poll?agent_names=demo_agent",
      "http://hub/api/executions/exec-1/traces",
      "http://hub/api/executions/exec-1/report",
    ]);
    expect(JSON.parse(requests[1].init?.body as string)).toEqual({
      traces: [{
        turn_index: 0,
        span_index: 0,
        role: "tool",
        span_type: "log",
        output_content: "Loaded 12 records",
      }],
    });
    expect(JSON.parse(requests[2].init?.body as string)).toMatchObject({
      status: "success",
      trace_count_expected: 1,
    });
    expect(consoleLog).toHaveBeenCalledWith("[exec-1] Loaded 12 records");
  });

  test("trace spans record handler checkpoints before reporting", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://hub/api/executions/exec-1/traces") {
        return jsonResponse({ ok: true, count: 1 });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async (ctx) => {
      const span = ctx.trace.startSpan("extract records");
      span.setOutput({ rows: 12 });
      span.end();
      return { done: true };
    });

    await expect(client.runOnce()).resolves.toBe(true);

    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/executors/poll?agent_names=demo_agent",
      "http://hub/api/executions/exec-1/traces",
      "http://hub/api/executions/exec-1/report",
    ]);
    expect(JSON.parse(requests[1].init?.body as string)).toMatchObject({
      traces: [{
        turn_index: 0,
        span_index: 0,
        role: "tool",
        span_type: "custom",
        input_content: "extract records",
        output_content: "{\"rows\":12}",
        metadata: { name: "extract records", status: "success" },
      }],
    });
    expect(JSON.parse(requests[2].init?.body as string)).toMatchObject({
      status: "success",
      trace_count_expected: 1,
    });
  });

  test("llm chat uses the execution abort signal by default", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let ctxSignal: AbortSignal | undefined;
    let llmSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://localhost:11434/v1/chat/completions") {
        llmSignal = init?.signal as AbortSignal | undefined;
        return jsonResponse({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        });
      }

      if (url === "http://hub/api/executions/exec-1/traces") {
        return jsonResponse({ ok: true, count: 1 });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async (ctx) => {
      ctxSignal = ctx.signal;
      const result = await ctx.llm.chat({
        model: "demo-model",
        messages: [{ role: "user", content: "Say hello" }],
      });
      return { content: result.content };
    });

    await expect(client.runOnce()).resolves.toBe(true);

    expect(llmSignal).toBe(ctxSignal);
    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/executors/poll?agent_names=demo_agent",
      "http://localhost:11434/v1/chat/completions",
      "http://hub/api/executions/exec-1/traces",
      "http://hub/api/executions/exec-1/report",
    ]);
  });

  test("progress reports execution progress through heartbeat", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://hub/api/executors/heartbeat") {
        return jsonResponse({ ok: true, executions_updated: 1 });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async (ctx) => {
      await ctx.progress(42, "Halfway through extraction");
      return { done: true };
    });

    await expect(client.runOnce()).resolves.toBe(true);

    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/executors/poll?agent_names=demo_agent",
      "http://hub/api/executors/heartbeat",
      "http://hub/api/executions/exec-1/report",
    ]);
    expect(JSON.parse(requests[1].init?.body as string)).toEqual({
      agent_names: ["demo_agent"],
      executions: [{
        execution_id: "exec-1",
        progress_percent: 42,
        progress_message: "Halfway through extraction",
      }],
    });
  });

  test("progress aborts the execution and skips reporting when the hub cancels it", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let signalAborted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://hub/api/executors/heartbeat") {
        return jsonResponse({
          ok: true,
          executions_updated: 0,
          cancelled_execution_ids: ["exec-1"],
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async (ctx) => {
      try {
        await ctx.progress(10, "Stopping");
      } finally {
        signalAborted = ctx.signal.aborted;
      }
      return { shouldNotReport: true };
    });

    await expect(client.runOnce()).resolves.toBe(true);

    expect(signalAborted).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/executors/poll?agent_names=demo_agent",
      "http://hub/api/executors/heartbeat",
    ]);
  });

  test("flushes buffered traces when the hub cancels an execution", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://hub/api/executors/heartbeat") {
        return jsonResponse({
          ok: true,
          executions_updated: 0,
          cancelled_execution_ids: ["exec-1"],
        });
      }

      if (url === "http://hub/api/executions/exec-1/traces") {
        return jsonResponse({ ok: true, count: 1 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_handler", async (ctx) => {
      await ctx.log("Last checkpoint before cancel");
      await ctx.progress(10, "Stopping");
      return { shouldNotReport: true };
    });

    await expect(client.runOnce()).resolves.toBe(true);

    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/executors/poll?agent_names=demo_agent",
      "http://hub/api/executors/heartbeat",
      "http://hub/api/executions/exec-1/traces",
    ]);
    expect(JSON.parse(requests[2].init?.body as string)).toEqual({
      traces: [{
        turn_index: 0,
        span_index: 0,
        role: "tool",
        span_type: "log",
        output_content: "Last checkpoint before cancel",
      }],
    });
  });

  test("runOnce can dispatch handlers registered by agent name", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/executors/poll?agent_names=demo_agent") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_agent",
          handlerName: "demo_handler",
          triggerType: "api",
          status: "running",
          inputPayload: {},
        });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubClient({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });
    client.register({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      handler: "demo_handler",
    });
    client.handle("demo_agent", async () => ({ dispatchedByAgentName: true }));

    await expect(client.runOnce()).resolves.toBe(true);

    expect(JSON.parse(requests[1].init?.body as string)).toMatchObject({
      status: "success",
      result_data: { dispatchedByAgentName: true },
    });
  });
});

describe("AgentHubControlClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("ready checks the unauthenticated readiness endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/ready");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        "Agent-Hub-Version": "1",
      });
      expect(init?.headers).not.toMatchObject({
        Authorization: expect.any(String),
      });
      expect(init?.body).toBeUndefined();
      return jsonResponse({ status: "ok", checks: { database: { status: "ok" } } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.ready()).resolves.toEqual({
      status: "ok",
      checks: { database: { status: "ok" } },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("getMetrics reads the unauthenticated operational metrics endpoint", async () => {
    const snapshot = {
      agents_total: 3,
      agents_enabled: 3,
      agents_online: 2,
      executions_queued: 1,
      alerts_active: 0,
      scheduler: {
        running: true,
        tick_count: 42,
        last_tick_error_count: 0,
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/metrics");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        "Agent-Hub-Version": "1",
      });
      expect(init?.headers).not.toMatchObject({
        Authorization: expect.any(String),
      });
      expect(init?.body).toBeUndefined();
      return jsonResponse(snapshot);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.getMetrics()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("listProjects reads sanitized project records from the dashboard endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/projects");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(init?.body).toBeUndefined();
      return jsonResponse([
        { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.listProjects()).resolves.toEqual([
      { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("doctor returns a structured project diagnostics report", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      requests.push(url);
      if (url === "http://hub/api/health") {
        return jsonResponse({ status: "ok" });
      }
      if (url === "http://hub/api/ready") {
        return jsonResponse({ status: "ok" });
      }
      if (url === "http://hub/api/metrics") {
        return jsonResponse({
          alerts_active: 1,
          scheduler: {
            running: true,
          },
        });
      }
      if (url === "http://hub/api/projects") {
        return jsonResponse([
          { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
        ]);
      }
      if (url === "http://hub/api/agents?project=project-1") {
        return jsonResponse([
          { id: "agent-1", name: "deep_research", executorStatus: "online" },
        ]);
      }
      if (url === "http://hub/api/executors?project=project-1") {
        return jsonResponse([
          { agent_name: "deep_research", executor_status: "online" },
        ]);
      }
      if (url === "http://hub/api/alerts?limit=20") {
        return jsonResponse([
          { id: 7, ruleName: "failed_runs", acknowledgedAt: null },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.doctor({ project: "oph" })).resolves.toMatchObject({
      ok: true,
      serverUrl: "http://hub",
      project: {
        requested: "oph",
        found: true,
        id: "project-1",
        name: "oph",
      },
      summary: {
        errors: 0,
        warnings: 1,
      },
      checks: expect.arrayContaining([
        { name: "health", status: "ok" },
        { name: "ready", status: "ok" },
        { name: "scheduler", status: "ok" },
        { name: "project", status: "ok", message: "Project oph found" },
        { name: "alerts", status: "warning", message: "1 active alert(s)" },
      ]),
    });
    expect(requests).toEqual([
      "http://hub/api/health",
      "http://hub/api/ready",
      "http://hub/api/metrics",
      "http://hub/api/projects",
      "http://hub/api/agents?project=project-1",
      "http://hub/api/executors?project=project-1",
      "http://hub/api/alerts?limit=20",
    ]);
  });

  test("getOpsStatus returns a project-scoped operational snapshot", async () => {
    const requests: string[] = [];
    const metrics = {
      agents_total: 3,
      agents_online: 2,
      agents_offline: 1,
      executions_queued: 1,
      executions_running: 1,
      executions_failed: 0,
      executions_timeout: 0,
      alerts_active: 1,
      scheduler: {
        running: true,
        tick_count: 42,
        last_tick_error_count: 0,
      },
    };
    const scheduler = {
      runtime: { running: true },
      agents: [{ name: "enrich_repo", dispatchState: "ready" }],
    };
    const agents = [
      { id: "agent-1", name: "enrich_repo", executorStatus: "online" },
      { id: "agent-2", name: "deep_research", executorStatus: "offline" },
    ];
    const executors = [
      { agent_name: "enrich_repo", executor_status: "online" },
    ];
    const alerts = [
      { id: 7, ruleName: "failed_runs", acknowledgedAt: null },
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      requests.push(url);
      if (url === "http://hub/api/health") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/ready") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/metrics") return jsonResponse(metrics);
      if (url === "http://hub/api/projects") {
        return jsonResponse([
          { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
        ]);
      }
      if (url === "http://hub/api/agents?project=project-1") return jsonResponse(agents);
      if (url === "http://hub/api/executors?project=project-1") return jsonResponse(executors);
      if (url === "http://hub/api/alerts?limit=20") return jsonResponse(alerts);
      if (url === "http://hub/api/scheduler/status?project=project-1") return jsonResponse(scheduler);
      if (url === "http://hub/api/alerts?limit=5") return jsonResponse(alerts);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.getOpsStatus({ project: "oph", alertLimit: 5 })).resolves.toMatchObject({
      ok: true,
      project: {
        requested: "oph",
        found: true,
        id: "project-1",
        name: "oph",
      },
      summary: {
        errors: 0,
        warnings: 1,
        schedulerRunning: true,
        agentsTotal: 2,
        agentsOnline: 1,
        executorsOnline: 1,
        activeAlerts: 1,
        executionsQueued: 1,
        executionsRunning: 1,
      },
      metrics,
      scheduler,
      agents,
      executors,
      alerts,
    });
    expect(requests).toEqual([
      "http://hub/api/health",
      "http://hub/api/ready",
      "http://hub/api/metrics",
      "http://hub/api/projects",
      "http://hub/api/agents?project=project-1",
      "http://hub/api/executors?project=project-1",
      "http://hub/api/alerts?limit=20",
      "http://hub/api/scheduler/status?project=project-1",
      "http://hub/api/agents?project=project-1",
      "http://hub/api/executors?project=project-1",
      "http://hub/api/alerts?limit=5",
    ]);
  });

  test("getOpsStatus can treat warnings as a failed snapshot", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.getOpsStatus({ project: "oph", failOnWarning: true })).resolves.toMatchObject({
      ok: false,
      summary: {
        errors: 0,
        warnings: 1,
      },
    });
  });

  test("doctor reports a missing requested project as an error", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "http://hub/api/health") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/ready") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/metrics") return jsonResponse({ scheduler: { running: true }, alerts_active: 0 });
      if (url === "http://hub/api/projects") return jsonResponse([]);
      if (url === "http://hub/api/alerts?limit=20") return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.doctor({ project: "oph" })).resolves.toMatchObject({
      ok: false,
      project: {
        requested: "oph",
        found: false,
      },
      summary: {
        errors: 1,
      },
      checks: expect.arrayContaining([
        { name: "project", status: "error", message: "Project oph not found" },
      ]),
    });
  });

  test("createProject and rotateProjectApiKey manage project-bound API keys", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      if (input.toString() === "http://hub/api/projects") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({
          name: "oph",
          displayName: "Open Source Project Hunter",
          description: "OPH executor integration",
        });
        return jsonResponse({
          project: { id: "project-1", name: "oph" },
          api_key: "agh_created",
        }, { status: 201 });
      }
      if (input.toString() === "http://hub/api/projects/project-1/api-key") {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeUndefined();
        return jsonResponse({
          project: { id: "project-1", name: "oph" },
          api_key: "agh_rotated",
        });
      }
      throw new Error(`Unexpected request: ${input.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.createProject({
      name: "oph",
      displayName: "Open Source Project Hunter",
      description: "OPH executor integration",
    })).resolves.toEqual({
      project: { id: "project-1", name: "oph" },
      api_key: "agh_created",
    });
    await expect(client.rotateProjectApiKey("project-1")).resolves.toEqual({
      project: { id: "project-1", name: "oph" },
      api_key: "agh_rotated",
    });
    expect(requests[0].init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
      "Agent-Hub-Version": "1",
    });
    expect(requests[1].init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
      "Agent-Hub-Version": "1",
    });
  });

  test("ensureProject returns an existing project without rotating or exposing keys", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/projects");
      expect(init?.method).toBe("GET");
      return jsonResponse([
        { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.ensureProject({
      name: "oph",
      displayName: "Open Source Project Hunter",
    })).resolves.toEqual({
      created: false,
      project: { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("drainProject resolves a project name and drains it by id", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });
      if (url === "http://hub/api/projects") {
        return jsonResponse([
          { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
        ]);
      }
      if (url === "http://hub/api/projects/project-1/drain") {
        return jsonResponse({
          ok: true,
          project_id: "project-1",
          agents_drained: 3,
          cancelled_queued: 2,
          cancelled_running: 1,
          active_execution_count: 0,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
    });

    await expect(client.drainProject("oph", { cancelRunning: true })).resolves.toMatchObject({
      ok: true,
      project_id: "project-1",
      agents_drained: 3,
      cancelled_queued: 2,
      cancelled_running: 1,
      active_execution_count: 0,
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/projects",
      "http://hub/api/projects/project-1/drain",
    ]);
    expect(JSON.parse(requests[1].init?.body as string)).toEqual({ cancel_running: true });
  });

  test("drainProject reports missing projects before sending drain requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "http://hub/api/projects") return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
    });

    await expect(client.drainProject("oph")).rejects.toThrow("Agent Hub project oph not found");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("setProjectEnabled resolves a project name and toggles project agents", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });
      if (url === "http://hub/api/projects") {
        return jsonResponse([
          { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
        ]);
      }
      if (url === "http://hub/api/agents/bulk") {
        return jsonResponse({ ok: true, count: 3 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
    });

    await expect(client.setProjectEnabled("oph", true)).resolves.toEqual({
      ok: true,
      count: 3,
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/projects",
      "http://hub/api/agents/bulk",
    ]);
    expect(JSON.parse(requests[1].init?.body as string)).toEqual({
      project: "project-1",
      enabled: true,
    });
  });

  test("setProjectEnabled reports missing projects before sending bulk patch requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "http://hub/api/projects") return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
    });

    await expect(client.setProjectEnabled("oph", false)).rejects.toThrow("Agent Hub project oph not found");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("ensureProject creates a missing project and returns the one-time API key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      if (input.toString() === "http://hub/api/projects" && init?.method === "GET") {
        return jsonResponse([]);
      }
      if (input.toString() === "http://hub/api/projects" && init?.method === "POST") {
        expect(JSON.parse(init?.body as string)).toEqual({
          name: "oph",
          displayName: "Open Source Project Hunter",
        });
        return jsonResponse({
          project: { id: "project-1", name: "oph" },
          api_key: "agh_created",
        }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${input.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.ensureProject({
      name: "oph",
      displayName: "Open Source Project Hunter",
    })).resolves.toEqual({
      created: true,
      project: { id: "project-1", name: "oph" },
      api_key: "agh_created",
    });
    expect(requests).toHaveLength(2);
  });

  test("listAgents reads dashboard APIs with basic auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.origin + url.pathname).toBe("http://hub/api/agents");
      expect(url.searchParams.get("status")).toBe("online");
      expect(url.searchParams.get("type")).toBe("llm_agent");
      expect(url.searchParams.get("archived")).toBe("only");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      return jsonResponse([{ id: "agent-1", name: "demo_agent" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub/",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.listAgents({ status: "online", type: "llm_agent", archived: "only" })).resolves.toEqual([
      { id: "agent-1", name: "demo_agent" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("listAgents resolves project names before querying dashboard agents", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      requests.push(url);
      if (url === "http://hub/api/projects") {
        return jsonResponse([
          { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
        ]);
      }
      if (url === "http://hub/api/agents?project=project-1") {
        return jsonResponse([{ id: "agent-1", name: "deep_research" }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.listAgents({ project: "oph" })).resolves.toEqual([
      { id: "agent-1", name: "deep_research" },
    ]);
    expect(requests).toEqual([
      "http://hub/api/projects",
      "http://hub/api/agents?project=project-1",
    ]);
  });

  test("getAgent can explicitly include archived records", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe(`http://hub/api/agents/${directAgentId}?include_archived=true`);
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(init?.body).toBeUndefined();
      return jsonResponse({ id: directAgentId, archivedAt: "2026-05-20T10:00:00.000Z" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.getAgent(directAgentId, { includeArchived: true })).resolves.toEqual({
      id: directAgentId,
      archivedAt: "2026-05-20T10:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("getSchedulerStatus reads scheduler diagnostics from the dashboard endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/scheduler/status?agent_id=agent-1");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(init?.body).toBeUndefined();
      return jsonResponse({
        generatedAt: "2026-05-20T10:00:00.000Z",
        agents: [{ id: "agent-1", dispatchState: "dispatchable" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.getSchedulerStatus({ agent_id: "agent-1" })).resolves.toEqual({
      generatedAt: "2026-05-20T10:00:00.000Z",
      agents: [{ id: "agent-1", dispatchState: "dispatchable" }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("listExecutors reads executor status from the dashboard endpoint", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input.toString());
      if (input.toString() === "http://hub/api/projects") {
        return jsonResponse([
          { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
        ]);
      }
      expect(input.toString()).toBe("http://hub/api/executors?project=project-1");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(init?.body).toBeUndefined();
      return jsonResponse([{ agent_name: "oph_deep_research", executor_status: "online" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.listExecutors({ project: "oph" })).resolves.toEqual([
      { agent_name: "oph_deep_research", executor_status: "online" },
    ]);
    expect(requests).toEqual([
      "http://hub/api/projects",
      "http://hub/api/executors?project=project-1",
    ]);
  });

  test("listAlerts and acknowledgeAlert operate on dashboard alert endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      if (input.toString() === "http://hub/api/alerts?limit=5&include_acknowledged=true") {
        return jsonResponse([{ id: 7, ruleName: "failed_runs", acknowledgedAt: null }]);
      }
      if (input.toString() === "http://hub/api/alerts/7/acknowledge") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({ acknowledgedBy: "agent" });
        return jsonResponse({ id: 7, acknowledgedBy: "agent" });
      }
      throw new Error(`Unexpected request: ${input.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.listAlerts({ limit: 5, includeAcknowledged: true })).resolves.toEqual([
      { id: 7, ruleName: "failed_runs", acknowledgedAt: null },
    ]);
    await expect(client.acknowledgeAlert(7, { acknowledgedBy: "agent" })).resolves.toEqual({
      id: 7,
      acknowledgedBy: "agent",
    });
    expect(requests[0].init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
      "Agent-Hub-Version": "1",
    });
    expect(requests[1].init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
      "Agent-Hub-Version": "1",
    });
  });

  test("triggerAgent writes through the API-key agent endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/agents/demo_agent/trigger");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer dev-key",
        "Agent-Hub-Version": "1",
        "X-Trigger-Source": "cli",
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        payload: { value: 42 },
        idempotency_key: "manual-42",
        dedup_policy: "skip_if_exists",
      });
      return jsonResponse({ execution_id: "exec-1", status: "queued", duplicate: false }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.triggerAgent("demo_agent", {
      payload: { value: 42 },
      idempotencyKey: "manual-42",
      dedupPolicy: "skip_if_exists",
    })).resolves.toEqual({ execution_id: "exec-1", status: "queued", duplicate: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("triggerAgentAndWait triggers work then waits for the terminal execution", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input.toString());
      if (input.toString() === "http://hub/api/agents/demo_agent/trigger") {
        expect(init?.method).toBe("POST");
        return jsonResponse({ execution_id: "exec-1", status: "queued", duplicate: false }, { status: 202 });
      }
      if (input.toString() === "http://hub/api/executions/exec-1") {
        return jsonResponse({ id: "exec-1", status: "success", resultSummary: "done" });
      }
      throw new Error(`Unexpected request: ${input.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.triggerAgentAndWait("demo_agent", {
      payload: { value: 42 },
    }, {
      intervalMs: 0,
      timeoutMs: 1000,
      requireSuccess: true,
    })).resolves.toEqual({
      trigger: { execution_id: "exec-1", status: "queued", duplicate: false },
      execution: { id: "exec-1", status: "success", resultSummary: "done" },
    });
    expect(requests).toEqual([
      "http://hub/api/agents/demo_agent/trigger",
      "http://hub/api/executions/exec-1",
    ]);
  });

  test("runCanary checks diagnostics before and after a successful trigger", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push(url);
      if (url === "http://hub/api/health") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/ready") return jsonResponse({ status: "ok" });
      if (url === "http://hub/api/metrics") return jsonResponse({ scheduler: { running: true }, alerts_active: 0 });
      if (url === "http://hub/api/projects") {
        return jsonResponse([{ id: "project-1", name: "oph", displayName: "Open Source Project Hunter" }]);
      }
      if (url === "http://hub/api/agents?project=project-1") {
        return jsonResponse([{ id: "agent-1", name: "enrich_repo", executorStatus: "online" }]);
      }
      if (url === "http://hub/api/executors?project=project-1") {
        return jsonResponse([{ agent_name: "enrich_repo", executor_status: "online" }]);
      }
      if (url === "http://hub/api/alerts?limit=20") return jsonResponse([]);
      if (url === "http://hub/api/agents/enrich_repo/trigger") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({
          payload: { repo_name: "agent-hub-smoke" },
          idempotency_key: undefined,
          dedup_policy: "allow_duplicate",
        });
        return jsonResponse({ execution_id: "exec-1", status: "queued", duplicate: false }, { status: 202 });
      }
      if (url === "http://hub/api/executions/exec-1") {
        return jsonResponse({ id: "exec-1", status: "success", resultSummary: "done" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.runCanary("enrich_repo", {
      project: "oph",
      payload: { repo_name: "agent-hub-smoke" },
      intervalMs: 0,
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      preflight: { ok: true, project: { name: "oph" } },
      trigger: { execution_id: "exec-1", status: "queued", duplicate: false },
      execution: { id: "exec-1", status: "success" },
      postflight: { ok: true, project: { name: "oph" } },
    });
    expect(requests).toEqual([
      "http://hub/api/health",
      "http://hub/api/ready",
      "http://hub/api/metrics",
      "http://hub/api/projects",
      "http://hub/api/agents?project=project-1",
      "http://hub/api/executors?project=project-1",
      "http://hub/api/alerts?limit=20",
      "http://hub/api/agents/enrich_repo/trigger",
      "http://hub/api/executions/exec-1",
      "http://hub/api/health",
      "http://hub/api/ready",
      "http://hub/api/metrics",
      "http://hub/api/projects",
      "http://hub/api/agents?project=project-1",
      "http://hub/api/executors?project=project-1",
      "http://hub/api/alerts?limit=20",
    ]);
  });

  test("triggerAgentAndWait rejects if the trigger response lacks an execution id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "queued" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.triggerAgentAndWait("demo_agent")).rejects.toThrow(/did not include execution_id/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("setAgentEnabled patches the dashboard agent endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe(`http://hub/api/agents/${directAgentId}`);
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(JSON.parse(init?.body as string)).toEqual({ enabled: false });
      return jsonResponse({ id: directAgentId, enabled: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.setAgentEnabled(directAgentId, false)).resolves.toEqual({ id: directAgentId, enabled: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("setAgentEnabled resolves an agent name inside a project before patching", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      if (input.toString() === "http://hub/api/projects") {
        return jsonResponse([
          { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
        ]);
      }
      if (input.toString() === "http://hub/api/agents?project=project-1") {
        return jsonResponse([
          { id: "agent-1", projectId: "project-1", name: "deep_research", enabled: false },
        ]);
      }
      if (input.toString() === "http://hub/api/agents/agent-1") {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(init?.body as string)).toEqual({ enabled: true });
        return jsonResponse({ id: "agent-1", name: "deep_research", enabled: true });
      }
      throw new Error(`Unexpected request: ${input.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.setAgentEnabled("deep_research", true, {
      project: "oph",
    })).resolves.toEqual({ id: "agent-1", name: "deep_research", enabled: true });
    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/projects",
      "http://hub/api/agents?project=project-1",
      "http://hub/api/agents/agent-1",
    ]);
  });

  test("name-based agent operations reject ambiguous names without a project", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (input.toString() === "http://hub/api/agents") {
        return jsonResponse([
          { id: "agent-1", projectId: "project-1", name: "deep_research" },
          { id: "agent-2", projectId: "project-2", name: "deep_research" },
        ]);
      }
      throw new Error(`Unexpected request: ${input.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.setAgentEnabled("deep_research", false)).rejects.toThrow(
      "Agent Hub agent deep_research is ambiguous; pass --project",
    );
  });

  test("createAgent posts a dashboard-managed agent", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/agents");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        name: "demo_agent",
        displayName: "Demo Agent",
        description: "Runs the demo handler for SDK executor tests.",
        agentType: "cron_task",
        cronExpression: "*/15 * * * *",
        handlerName: "demo_handler",
        concurrency: 2,
        timeoutSeconds: 120,
      });
      return jsonResponse({ id: "agent-1", name: "demo_agent" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.createAgent({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for SDK executor tests.",
      agentType: "cron_task",
      cronExpression: "*/15 * * * *",
      handlerName: "demo_handler",
      concurrency: 2,
      timeoutSeconds: 120,
    })).resolves.toEqual({ id: "agent-1", name: "demo_agent" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("updateAgent patches dashboard-managed agent settings", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe(`http://hub/api/agents/${directAgentId}`);
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        displayName: "Renamed Agent",
        cronExpression: null,
        handlerName: "renamed_handler",
        retryMax: 0,
      });
      return jsonResponse({ id: directAgentId, displayName: "Renamed Agent" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.updateAgent(directAgentId, {
      displayName: "Renamed Agent",
      cronExpression: null,
      handlerName: "renamed_handler",
      retryMax: 0,
    })).resolves.toEqual({ id: directAgentId, displayName: "Renamed Agent" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("getAgentSchedulePreview reads future cron runs from the dashboard endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe(`http://hub/api/agents/${directAgentId}/schedule-preview?limit=3`);
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(init?.body).toBeUndefined();
      return jsonResponse({ runs: ["2026-05-20T12:00:00.000Z"] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.getAgentSchedulePreview(directAgentId, { limit: 3 })).resolves.toEqual({
      runs: ["2026-05-20T12:00:00.000Z"],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("deleteAgent deletes a dashboard-managed agent", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe(`http://hub/api/agents/${directAgentId}`);
      expect(init?.method).toBe("DELETE");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.deleteAgent(directAgentId)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("drainAgent posts queued and running cancellation intent", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe(`http://hub/api/agents/${directAgentId}/drain`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      expect(JSON.parse(init?.body as string)).toEqual({ cancel_running: true });
      return jsonResponse({
        ok: true,
        agent_id: directAgentId,
        cancelled_queued: 1,
        cancelled_running: 1,
        active_execution_count: 0,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.drainAgent(directAgentId, { cancelRunning: true })).resolves.toEqual({
      ok: true,
      agent_id: directAgentId,
      cancelled_queued: 1,
      cancelled_running: 1,
      active_execution_count: 0,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("cancelExecution writes through the dashboard endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/executions/exec-1/cancel");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      return jsonResponse({ ok: true, status: "cancelled" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.cancelExecution("exec-1")).resolves.toEqual({ ok: true, status: "cancelled" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("rerunExecution writes through the dashboard endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe("http://hub/api/executions/exec-1/rerun");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}`,
        "Agent-Hub-Version": "1",
      });
      return jsonResponse({
        execution_id: "exec-2",
        source_execution_id: "exec-1",
        status: "queued",
      }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.rerunExecution("exec-1")).resolves.toEqual({
      execution_id: "exec-2",
      source_execution_id: "exec-1",
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("waitForExecution polls until the execution reaches a terminal status", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requests.push(input.toString());
      if (requests.length === 1) {
        return jsonResponse({ id: "exec-1", status: "running" });
      }
      return jsonResponse({ id: "exec-1", status: "success", resultSummary: "done" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.waitForExecution("exec-1", {
      intervalMs: 0,
      timeoutMs: 1000,
    })).resolves.toEqual({
      id: "exec-1",
      status: "success",
      resultSummary: "done",
    });
    expect(requests).toEqual([
      "http://hub/api/executions/exec-1",
      "http://hub/api/executions/exec-1",
    ]);
  });

  test("waitForExecution rejects when the execution does not finish before timeout", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "exec-1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.waitForExecution("exec-1", {
      intervalMs: 0,
      timeoutMs: 0,
    })).rejects.toThrow(/timed out/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("waitForExecution can require a successful terminal status", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "exec-1", status: "failed" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgentHubControlClient({
      serverUrl: "http://hub",
      dashboardUsername: "admin",
      dashboardPassword: "secret",
      apiKey: "dev-key",
    });

    await expect(client.waitForExecution("exec-1", {
      requireSuccess: true,
    })).rejects.toThrow(/terminal status failed/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
