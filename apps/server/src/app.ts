import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createPool, createDb, closePool } from "./db/connection.js";
import { seedIfEmpty } from "./db/seed.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { AgentRepository } from "./repositories/agent-repository.js";
import { ExecutionRepository } from "./repositories/execution-repository.js";
import { TraceRepository } from "./repositories/trace-repository.js";
import { registerRoutes } from "./http/routes.js";
import { basicAuth } from "./middleware/auth.js";
import { serverConfig } from "./config.js";

export interface AppContext {
  projectRepo: ProjectRepository;
  agentRepo: AgentRepository;
  executionRepo: ExecutionRepository;
  traceRepo: TraceRepository;
}

export async function createApp(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // PostgreSQL
  const pool = createPool(serverConfig.databaseUrl);
  const db = createDb(pool);

  // Seed default project + demo agent if database is empty
  await seedIfEmpty(db);

  // Repositories
  const projectRepo = new ProjectRepository(db);
  const agentRepo = new AgentRepository(db);
  const executionRepo = new ExecutionRepository(db);
  const traceRepo = new TraceRepository(db);

  const ctx: AppContext = { projectRepo, agentRepo, executionRepo, traceRepo };

  // Dashboard Basic Auth
  app.addHook("onRequest", basicAuth);

  // Routes
  registerRoutes(app, ctx);

  // Error handler
  app.setErrorHandler((error: any, _request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode ?? 500).send({
      error: error.message ?? "Internal Server Error",
    });
  });

  // Graceful shutdown
  app.addHook("onClose", async () => {
    await closePool();
  });

  return { app, ctx };
}
