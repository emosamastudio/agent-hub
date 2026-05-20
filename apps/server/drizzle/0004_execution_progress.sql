ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "progress_percent" integer;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "progress_message" text;
