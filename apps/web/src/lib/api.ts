import type { AgentEvent, DashboardSnapshot, RunAction } from "@agent-hub/shared";

type DashboardSocketMessage =
  | { type: "event"; data: AgentEvent }
  | { type: "snapshot"; data: DashboardSnapshot };

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

function withBase(pathname: string) {
  return `${apiBase}${pathname}`;
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const fallback = `Request failed with status ${response.status}.`;

    try {
      const body = (await response.json()) as { message?: string };
      throw new Error(body.message ?? fallback);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      throw new Error(fallback);
    }
  }

  return (await response.json()) as T;
}

export async function fetchSnapshot() {
  const response = await fetch(withBase("/api/snapshot"));
  return readResponse<DashboardSnapshot>(response);
}

export async function postRunAction(runId: string, action: RunAction) {
  const response = await fetch(withBase(`/api/runs/${runId}/actions`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ action }),
  });

  return readResponse<{
    event: AgentEvent;
    snapshot: DashboardSnapshot;
  }>(response);
}

export function connectDashboardSocket(handlers: {
  onClose: () => void;
  onOpen: () => void;
  onSnapshot: (snapshot: DashboardSnapshot) => void;
}) {
  const socket = new WebSocket(resolveSocketUrl());

  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("close", handlers.onClose);
  socket.addEventListener("error", handlers.onClose);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as DashboardSocketMessage;

    if (message.type === "snapshot") {
      handlers.onSnapshot(message.data);
    }
  });

  return () => {
    socket.close();
  };
}

function resolveSocketUrl() {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  if (apiBase) {
    const url = new URL(apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}
