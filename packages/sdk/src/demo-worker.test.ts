import { afterEach, describe, expect, test, vi } from "vitest";
import { createDemoWorker, demoWorkerAgentSpec } from "./demo-worker";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("demo Node worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("registers the demo agent and processes one execution through the SDK", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });

      if (url === "http://hub/api/registry/agents") {
        return jsonResponse({ id: "agent-1", name: demoWorkerAgentSpec.name });
      }

      if (url === "http://hub/api/executors/poll?agent_names=demo_node_worker") {
        return jsonResponse({
          id: "exec-1",
          agentId: "agent-1",
          agentName: "demo_node_worker",
          handlerName: "demo_node_worker_handler",
          triggerType: "api",
          status: "running",
          inputPayload: { items: ["alpha", "beta"] },
          timeoutSeconds: 60,
        });
      }

      if (url === "http://hub/api/executors/heartbeat") {
        return jsonResponse({ ok: true, executions_updated: 1 });
      }

      if (url === "http://hub/api/executions/exec-1/traces") {
        return jsonResponse({ ok: true, count: 2 });
      }

      if (url === "http://hub/api/executions/exec-1/report") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const worker = createDemoWorker({
      serverUrl: "http://hub",
      project: "default",
      apiKey: "dev-key",
    });

    await expect(worker.syncRegistry()).resolves.toEqual([{ id: "agent-1", name: "demo_node_worker" }]);
    await expect(worker.runOnce()).resolves.toBe(true);

    expect(requests.map((request) => request.url)).toEqual([
      "http://hub/api/registry/agents",
      "http://hub/api/executors/poll?agent_names=demo_node_worker",
      "http://hub/api/executors/heartbeat",
      "http://hub/api/executors/heartbeat",
      "http://hub/api/executions/exec-1/traces",
      "http://hub/api/executions/exec-1/report",
    ]);
    expect(JSON.parse(requests[0].init?.body as string)).toMatchObject(demoWorkerAgentSpec);
    expect(JSON.parse(requests[4].init?.body as string)).toMatchObject({
      traces: [
        {
          turn_index: 0,
          span_index: 0,
          role: "tool",
          span_type: "log",
          output_content: "Processing 2 item(s)",
        },
        {
          turn_index: 0,
          span_index: 1,
          role: "tool",
          span_type: "custom",
          input_content: "process demo payload",
          output_content: JSON.stringify({ itemCount: 2 }),
          metadata: {
            name: "process demo payload",
            status: "success",
          },
        },
      ],
    });
    expect(JSON.parse(requests[5].init?.body as string)).toMatchObject({
      status: "success",
      result_data: {
        handledBy: "demo_node_worker",
        itemCount: 2,
        items: ["alpha", "beta"],
      },
      trace_count_expected: 2,
    });
  });
});
