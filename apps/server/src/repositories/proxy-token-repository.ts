import { eq, lt } from "drizzle-orm";
import { proxyTokens } from "../db/schema.js";
import type { Db } from "../db/repository.js";

export class ProxyTokenRepository {
  constructor(private db: Db) {}

  async create(input: {
    executionId: string;
    tokenHash: string;
    projectId: string;
    expiresAt: Date;
  }) {
    const rows = await this.db.insert(proxyTokens).values(input).returning();
    return rows[0];
  }

  async findByTokenHash(tokenHash: string) {
    const rows = await this.db
      .select()
      .from(proxyTokens)
      .where(eq(proxyTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async expireTokens() {
    await this.db.delete(proxyTokens).where(lt(proxyTokens.expiresAt, new Date()));
  }
}
