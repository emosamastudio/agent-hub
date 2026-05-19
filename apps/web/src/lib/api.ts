const BASE = "";

function authHeaders(): Record<string, string> {
  return { "Authorization": "Basic " + btoa("admin:admin") };
}

export async function fetchAgents(params?: Record<string, string>) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${BASE}/api/agents${qs}`, { headers: authHeaders() });
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

export async function fetchStats() {
  const res = await fetch(`${BASE}/api/stats`, { headers: authHeaders() });
  return res.json();
}

export async function patchAgent(id: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/agents/${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
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
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${location.host}/ws`);
}
