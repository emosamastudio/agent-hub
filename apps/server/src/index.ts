import { serverConfig } from "./config.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const app = await createApp();
  let isClosing = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isClosing) {
      return;
    }

    isClosing = true;
    app.log.info({ signal }, "Shutting down Agent Hub server");
    await app.close();
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await app.listen({
      host: serverConfig.host,
      port: serverConfig.port,
    });
  } catch (error) {
    app.log.error(error, "Failed to start Agent Hub server");
    await app.close();
    throw error;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
