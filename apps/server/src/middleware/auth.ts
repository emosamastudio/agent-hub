import type { FastifyRequest, FastifyReply } from "fastify";
import { serverConfig } from "../config.js";

export async function basicAuth(request: FastifyRequest, reply: FastifyReply) {
  // Skip auth for SDK endpoints (use API key instead)
  if (request.url.startsWith("/api/registry") ||
      request.url.startsWith("/api/executors") ||
      request.url.startsWith("/api/cooldowns") ||
      (request.url.startsWith("/api/executions/") && request.method === "POST") ||
      (request.url.startsWith("/api/agents/") && request.method === "POST")) {
    return;
  }

  // Skip auth for health and metrics
  if (request.url === "/api/health" || request.url === "/api/metrics") {
    return;
  }

  // All other dashboard API endpoints require Basic Auth
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    reply.header("WWW-Authenticate", 'Basic realm="Agent Cron Hub"');
    return reply.status(401).send({ error: "unauthorized" });
  }

  const [, credentials] = auth.split(" ");
  const [user, password] = Buffer.from(credentials, "base64").toString().split(":");
  if (password !== serverConfig.dashboardPassword) {
    return reply.status(401).send({ error: "unauthorized" });
  }
}
