import type { FastifyRequest, FastifyReply } from "fastify";
import { serverConfig } from "../config.js";
import { constantTimeEqual } from "../security.js";

export function getBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim() || null;
}

export function isValidDashboardBasicAuth(request: FastifyRequest): boolean {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) return false;

  const [, credentials] = auth.split(" ");
  if (!credentials) return false;

  const decoded = Buffer.from(credentials, "base64").toString();
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return false;

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return constantTimeEqual(username, serverConfig.dashboardUsername)
    && constantTimeEqual(password, serverConfig.dashboardPassword);
}

export async function basicAuth(request: FastifyRequest, reply: FastifyReply) {
  // Skip auth for SDK endpoints (use API key instead)
  if (request.url.startsWith("/api/registry") ||
      request.url.startsWith("/api/executors") ||
      request.url.startsWith("/api/cooldowns") ||
      (request.url.startsWith("/api/executions/") && request.method === "POST") ||
      (request.url.startsWith("/api/agents/") && request.method === "POST")) {
    return;
  }

  // Skip auth for WebSocket upgrade (browsers can't set auth headers on WS)
  if (request.url === "/ws") {
    return;
  }

  // Skip auth for health and metrics
  if (request.url === "/api/health" || request.url === "/api/metrics") {
    return;
  }

  // All other dashboard API endpoints require Basic Auth
  if (!isValidDashboardBasicAuth(request)) {
    return reply.status(401).send({ error: "unauthorized" });
  }
}
