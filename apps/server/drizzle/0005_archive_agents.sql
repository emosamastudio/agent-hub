ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_archived_at" ON "agents" USING btree ("archived_at");
