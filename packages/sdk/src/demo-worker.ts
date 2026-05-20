#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  AgentHubClient,
  type AgentHubConfig,
  type AgentSpec,
  type ExecutionContext,
} from "./index.js";

type Env = Record<string, string | undefined>;

export const demoWorkerAgentSpec: AgentSpec = {
  name: "demo_node_worker",
  displayName: "Demo Node Worker",
  description: "Demonstrates Node executor registration, polling, progress, tracing, and reporting.",
  agentType: "cron_task",
  cron: "*/15 * * * *",
  handler: "demo_node_worker_handler",
  concurrency: 1,
  timeoutSeconds: 60,
  retryMax: 1,
  maxPendingQueue: 10,
  labels: {
    example: "node-worker",
  },
};

export function buildDemoWorkerConfig(env: Env = process.env): AgentHubConfig {
  return {
    serverUrl: env.AGENT_HUB_URL ?? "http://127.0.0.1:8788",
    project: env.AGENT_HUB_PROJECT ?? "default",
    apiKey: env.AGENT_HUB_API_KEY ?? "agent_hub_dev_key",
  };
}

export function createDemoWorker(config: AgentHubConfig = buildDemoWorkerConfig()): AgentHubClient {
  const worker = new AgentHubClient(config);
  worker.register(demoWorkerAgentSpec);
  worker.handle(demoWorkerAgentSpec.handler, handleDemoWorkerExecution);
  return worker;
}

export async function handleDemoWorkerExecution(ctx: ExecutionContext): Promise<Record<string, unknown>> {
  await ctx.progress(10, "Accepted demo payload");
  const items = payloadItems(ctx.payload);
  await ctx.log(`Processing ${items.length} item(s)`);

  const span = ctx.trace.startSpan("process demo payload");
  try {
    span.setOutput({ itemCount: items.length });
    span.end();
  } catch (error) {
    span.error(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  await ctx.progress(100, "Demo payload processed");
  return {
    handledBy: demoWorkerAgentSpec.name,
    itemCount: items.length,
    items,
  };
}

export async function runDemoWorker(
  argv: string[] = process.argv.slice(2),
  env: Env = process.env,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText());
    return 0;
  }

  const worker = createDemoWorker(buildDemoWorkerConfig(env));
  if (argv.includes("--once")) {
    await worker.syncRegistry();
    await worker.runOnce();
    worker.stop();
    return 0;
  }

  await worker.start();
  return 0;
}

function payloadItems(payload: Record<string, unknown>): string[] {
  const items = payload.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => String(item));
}

function helpText(): string {
  return `Usage:
  agent-hub-demo-worker [--once]

Environment:
  AGENT_HUB_URL          Defaults to http://127.0.0.1:8788
  AGENT_HUB_PROJECT      Defaults to default
  AGENT_HUB_API_KEY      Defaults to agent_hub_dev_key
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDemoWorker().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
