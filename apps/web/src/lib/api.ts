import { authHeaders } from "./auth";

const BASE = "";

export async function fetchProjects() {
  const res = await fetch(`${BASE}/api/projects`, { headers: authHeaders() });
  return res.json();
}

export async function fetchAgents(params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${BASE}/api/agents${qs}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchAgentDetail(id: string, options: { includeArchived?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.includeArchived) params.set("include_archived", "true");
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}${qs}`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function fetchExecutions(params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${BASE}/api/executions${qs}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchExecutionDetail(id: string) {
  const res = await fetch(`${BASE}/api/executions/${id}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchTraces(executionId: string) {
  const res = await fetch(`${BASE}/api/executions/${executionId}/traces`, { headers: authHeaders() });
  return res.json();
}

export async function fetchTriggerChain(executionId: string) {
  const res = await fetch(`${BASE}/api/executions/${executionId}/trigger-chain`, {
    headers: authHeaders(),
  });
  return res.json();
}

export async function fetchSchedulePreview(agentId: string, limit = 5) {
  const qs = new URLSearchParams({ limit: String(limit) });
  const res = await fetch(`${BASE}/api/agents/${agentId}/schedule-preview?${qs}`, {
    headers: authHeaders(),
  });
  return res.json();
}

async function postExecutionAction(executionId: string, action: "cancel" | "rerun") {
  const res = await fetch(`${BASE}/api/executions/${executionId}/${action}`, {
    method: "POST",
    headers: authHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to ${action} execution`);
  }
  return body;
}

export async function cancelExecution(executionId: string) {
  return postExecutionAction(executionId, "cancel");
}

export async function rerunExecution(executionId: string) {
  return postExecutionAction(executionId, "rerun");
}

export async function fetchStats() {
  const res = await fetch(`${BASE}/api/stats`, { headers: authHeaders() });
  return res.json();
}

export async function fetchSchedulerStatus(params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${BASE}/api/scheduler/status${qs}`, { headers: authHeaders() });
  return res.json();
}

export async function fetchAlerts(params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${BASE}/api/alerts${qs}`, { headers: authHeaders() });
  return res.json();
}

export async function acknowledgeAlert(id: number, acknowledgedBy = "dashboard") {
  const res = await fetch(`${BASE}/api/alerts/${id}/acknowledge`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledgedBy }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error ?? "Failed to acknowledge alert");
  }
  return payload;
}

export async function patchAgent(id: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/agents/${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function deleteAgent(id: string) {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? "Failed to delete agent");
  }
}

export async function drainAgent(id: string, options: { cancelRunning?: boolean } = {}) {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(id)}/drain`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ cancel_running: options.cancelRunning === true }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error ?? "Failed to drain agent");
  }
  return payload;
}

export async function createAgent(body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error ?? "Failed to create agent");
  }
  return payload;
}

export async function triggerAgent(name: string, payload: unknown) {
  const res = await fetch(`${BASE}/api/agents/${name}/trigger`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      "X-Trigger-Source": "dashboard",
    },
    body: JSON.stringify({ payload }),
  });
  return res.json();
}

export function connectSocket(): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}/ws`);
}

export async function fetchThroughput(hours = 24): Promise<{ buckets: Array<{ hour: string } & Record<string, number>> }> {
  const res = await fetch(`${BASE}/api/stats/throughput?hours=${hours}`, { headers: authHeaders() });
  return res.json();
}
