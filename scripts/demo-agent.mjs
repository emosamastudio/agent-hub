#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const demoWorkerPath = resolve(here, "../packages/sdk/dist/demo-worker.js");

if (!existsSync(demoWorkerPath)) {
  process.stderr.write("Build the SDK first: npm run build -w @agent-hub/sdk\n");
  process.exit(1);
}

const { runDemoWorker } = await import(pathToFileURL(demoWorkerPath).href);

try {
  process.exitCode = await runDemoWorker(process.argv.slice(2), process.env);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
