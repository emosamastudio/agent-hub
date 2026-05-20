import { createApp } from "./app.js";
import { serverConfig } from "./config.js";
import { startScheduler } from "./services/scheduler.js";

async function main() {
  const { app, ctx: appCtx } = await createApp();

  // Startup recovery: align active_execution_count
  await appCtx.agentRepo.resetAllExecutionCounts();

  await app.listen({ host: serverConfig.host, port: serverConfig.port });
  console.log(`Agent Cron Hub listening on http://${serverConfig.host}:${serverConfig.port}`);

  // Start scheduler — reuses the same repos created by createApp
  startScheduler({
    agentRepo: appCtx.agentRepo,
    executionRepo: appCtx.executionRepo,
    traceRepo: appCtx.traceRepo,
    alertRepo: appCtx.alertRepo,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
