import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import type { Db } from "../db/repository.js";

export class ProjectRepository {
  constructor(private db: Db) {}

  async findAll() {
    return this.db.select().from(projects).orderBy(projects.createdAt);
  }

  async findById(id: string) {
    const rows = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByName(name: string) {
    const rows = await this.db.select().from(projects).where(eq(projects.name, name)).limit(1);
    return rows[0] ?? null;
  }

  async create(input: { name: string; displayName: string; description?: string; apiKeyHash?: string }) {
    const rows = await this.db.insert(projects).values({
      name: input.name,
      displayName: input.displayName,
      description: input.description ?? null,
      apiKeyHash: input.apiKeyHash ?? null,
    }).returning();
    return rows[0];
  }

  async update(id: string, input: Partial<{ displayName: string; description: string; status: string; apiKeyHash: string; dashboardPasswordHash: string }>) {
    const rows = await this.db.update(projects).set(input).where(eq(projects.id, id)).returning();
    return rows[0] ?? null;
  }

  async delete(id: string) {
    await this.db.delete(projects).where(eq(projects.id, id));
  }
}
