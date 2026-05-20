import type { Db } from "./repository.js";
import { projects, agents, providerPricing } from "./schema.js";
import { serverConfig } from "../config.js";
import { hashApiKey, hashPassword } from "../security.js";

export interface SeedOptions {
  bootstrapDefaultProject: boolean;
  seedDemoAgent: boolean;
}

export async function seedIfEmpty(db: Db, options: SeedOptions = serverConfig) {
  const existing = await db.select().from(projects).limit(1);
  if (existing.length > 0) return;
  if (!options.bootstrapDefaultProject) return;

  const [proj] = await db.insert(projects).values({
    name: "default",
    displayName: "Default Project",
    description: "Default project for local development",
    apiKeyHash: hashApiKey(serverConfig.defaultProjectApiKey),
    dashboardPasswordHash: hashPassword(serverConfig.dashboardPassword),
  }).returning();

  if (options.seedDemoAgent) {
    await db.insert(agents).values({
      projectId: proj.id,
      name: "demo_hello",
      displayName: "Demo Hello World",
      agentType: "cron_task",
      cronExpression: "*/5 * * * *",
      handlerName: "demo_handler",
      concurrency: 1,
      timeoutSeconds: 60,
      retryMax: 2,
      executorStatus: "offline",
      enabled: true,
    } as any);
  }

  // Seed provider pricing (major LLM providers, 2026 estimates)
  const pricingData = [
    { provider: "anthropic", model: "claude-opus-4-7", inputCost: 15.00, outputCost: 75.00 },
    { provider: "anthropic", model: "claude-sonnet-4-6", inputCost: 3.00, outputCost: 15.00 },
    { provider: "anthropic", model: "claude-haiku-4-5", inputCost: 0.80, outputCost: 4.00 },
    { provider: "openai", model: "gpt-5.4", inputCost: 2.50, outputCost: 10.00 },
    { provider: "deepseek", model: "deepseek-v4-pro", inputCost: 0.50, outputCost: 2.00 },
    { provider: "leihuo", model: "deepseek-v4-pro", inputCost: 0.50, outputCost: 2.00 },
  ];

  const existingPricing = await db.select().from(providerPricing).limit(1);
  if (existingPricing.length === 0) {
    for (const p of pricingData) {
      await db.insert(providerPricing).values({
        provider: p.provider,
        model: p.model,
        inputCostPer1k: p.inputCost.toString(),
        outputCostPer1k: p.outputCost.toString(),
        effectiveFrom: "2026-01-01",
      } as any);
    }
    console.log(`Seeded ${pricingData.length} provider pricing records`);
  }

  console.log(options.seedDemoAgent ? "Seeded default project and demo agent" : "Seeded default project");
}
