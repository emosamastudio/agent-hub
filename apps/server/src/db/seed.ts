import type { Db } from "./repository.js";
import { projects, agents } from "./schema.js";

export async function seedIfEmpty(db: Db) {
  const existing = await db.select().from(projects).limit(1);
  if (existing.length > 0) return;

  const [proj] = await db.insert(projects).values({
    name: "default",
    displayName: "Default Project",
    description: "Default project for local development",
    dashboardPasswordHash: "admin",
  }).returning();

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

  console.log("Seeded default project and demo agent");
}
