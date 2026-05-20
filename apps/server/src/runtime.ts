import type { FastifyInstance } from "fastify";
import { createApp, type AppContext } from "./app.js";
import { serverConfig } from "./config.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";

type ShutdownSignal = NodeJS.Signals;

interface CloseableApp {
  close: () => Promise<void>;
}

interface ShutdownDependencies {
  app: CloseableApp;
  stopScheduler: () => void;
  log?: (message: string) => void;
  error?: (error: unknown) => void;
  exit?: (code: number) => void;
}

export interface RunningAgentHubServer {
  app: FastifyInstance;
  ctx: AppContext;
  shutdown: (signal: ShutdownSignal) => Promise<void>;
}

export function createShutdownHandler({
  app,
  stopScheduler,
  log = console.log,
  error = console.error,
  exit = process.exit,
}: ShutdownDependencies) {
  let shutdownPromise: Promise<void> | null = null;

  return (signal: ShutdownSignal): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      log(`Received ${signal}, shutting down Agent Hub`);
      stopScheduler();

      try {
        await app.close();
        log("Agent Hub stopped");
      } catch (shutdownError) {
        error(shutdownError);
        exit(1);
      }
    })();

    return shutdownPromise;
  };
}

export function bindShutdownSignals(shutdown: (signal: ShutdownSignal) => Promise<void>) {
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

export async function startAgentHubServer(): Promise<RunningAgentHubServer> {
  const { app, ctx } = await createApp();

  await ctx.agentRepo.resetAllExecutionCounts();
  await app.listen({ host: serverConfig.host, port: serverConfig.port });
  console.log(`Agent Hub listening on http://${serverConfig.host}:${serverConfig.port}`);

  startScheduler({
    agentRepo: ctx.agentRepo,
    executionRepo: ctx.executionRepo,
    traceRepo: ctx.traceRepo,
    alertRepo: ctx.alertRepo,
  });

  const shutdown = createShutdownHandler({
    app,
    stopScheduler,
  });
  bindShutdownSignals(shutdown);

  return { app, ctx, shutdown };
}
