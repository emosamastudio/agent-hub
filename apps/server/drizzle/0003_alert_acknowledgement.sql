ALTER TABLE "alert_log" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_log" ADD COLUMN IF NOT EXISTS "acknowledged_by" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_alert_log_acknowledged_created_at" ON "alert_log" USING btree ("acknowledged_at","created_at");
