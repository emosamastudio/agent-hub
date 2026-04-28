import type { SqliteDatabase } from "../db/index.js";
import type { ResourcePolicyState } from "../shared-types.js";

interface ResourcePolicyRow {
  platform: ResourcePolicyState["platform"];
  slotLimit: number;
  updatedAt: string;
}

function mapResourcePolicyRow(row: ResourcePolicyRow): ResourcePolicyState {
  return {
    platform: row.platform,
    slotLimit: row.slotLimit,
    updatedAt: row.updatedAt,
  };
}

export class ResourcePolicyRepository {
  private readonly listStatement;
  private readonly getByPlatformStatement;
  private readonly upsertStatement;
  private readonly deleteStatement;

  constructor(private readonly db: SqliteDatabase) {
    const selectClause = `
      SELECT
        platform,
        slot_limit AS slotLimit,
        updated_at AS updatedAt
      FROM resource_policies
    `;

    this.listStatement = db.prepare<unknown[], ResourcePolicyRow>(
      `${selectClause} ORDER BY platform ASC`,
    );
    this.getByPlatformStatement = db.prepare<
      [ResourcePolicyState["platform"]],
      ResourcePolicyRow
    >(`${selectClause} WHERE platform = ?`);
    this.upsertStatement = db.prepare<ResourcePolicyState>(`
      INSERT INTO resource_policies (
        platform,
        slot_limit,
        updated_at
      ) VALUES (
        @platform,
        @slotLimit,
        @updatedAt
      )
      ON CONFLICT(platform) DO UPDATE SET
        slot_limit = excluded.slot_limit,
        updated_at = excluded.updated_at
    `);
    this.deleteStatement = db.prepare<[ResourcePolicyState["platform"]]>(
      "DELETE FROM resource_policies WHERE platform = ?",
    );
  }

  list(): ResourcePolicyState[] {
    return this.listStatement.all().map(mapResourcePolicyRow);
  }

  getByPlatform(platform: ResourcePolicyState["platform"]): ResourcePolicyState | null {
    const row = this.getByPlatformStatement.get(platform);
    return row ? mapResourcePolicyRow(row) : null;
  }

  upsert(policy: ResourcePolicyState): void {
    this.upsertStatement.run(policy);
  }

  deleteByPlatform(platform: ResourcePolicyState["platform"]): void {
    this.deleteStatement.run(platform);
  }
}
