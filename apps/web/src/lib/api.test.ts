import { afterEach, describe, expect, test, vi } from "vitest";
import { deleteAgent, drainAgent, fetchAgentDetail, fetchSchedulerStatus } from "./api";

function stubBrowserRuntime() {
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    },
    prompt: vi.fn(),
    btoa: (value: string) => {
      if (value === "admin:admin") return "YWRtaW46YWRtaW4=";
      throw new Error(`Unexpected btoa input: ${value}`);
    },
    location: { protocol: "http:", host: "127.0.0.1:5174" },
  });
}

describe("dashboard API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("deleteAgent sends an authenticated DELETE request", async () => {
    stubBrowserRuntime();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteAgent("agent-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent-1", {
      method: "DELETE",
      headers: {
        Authorization: "Basic YWRtaW46YWRtaW4=",
      },
    });
  });

  test("drainAgent sends authenticated cancellation intent", async () => {
    stubBrowserRuntime();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      agent_id: "agent-1",
      cancelled_queued: 1,
      cancelled_running: 1,
      active_execution_count: 0,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(drainAgent("agent-1", { cancelRunning: true })).resolves.toEqual({
      ok: true,
      agent_id: "agent-1",
      cancelled_queued: 1,
      cancelled_running: 1,
      active_execution_count: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent-1/drain", {
      method: "POST",
      headers: {
        Authorization: "Basic YWRtaW46YWRtaW4=",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cancel_running: true }),
    });
  });

  test("fetchAgentDetail can explicitly include archived agents", async () => {
    stubBrowserRuntime();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "agent-1",
      archivedAt: "2026-05-20T10:00:00.000Z",
      recentExecutions: [],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAgentDetail("agent-1", { includeArchived: true })).resolves.toEqual({
      id: "agent-1",
      archivedAt: "2026-05-20T10:00:00.000Z",
      recentExecutions: [],
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent-1?include_archived=true", {
      headers: {
        Authorization: "Basic YWRtaW46YWRtaW4=",
      },
    });
  });

  test("fetchSchedulerStatus reads authenticated scheduler diagnostics", async () => {
    stubBrowserRuntime();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      generatedAt: "2026-05-20T10:00:00.000Z",
      agents: [],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSchedulerStatus({ agent_id: "agent-1" })).resolves.toEqual({
      generatedAt: "2026-05-20T10:00:00.000Z",
      agents: [],
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/scheduler/status?agent_id=agent-1", {
      headers: {
        Authorization: "Basic YWRtaW46YWRtaW4=",
      },
    });
  });
});
