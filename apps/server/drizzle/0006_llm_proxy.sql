CREATE TABLE IF NOT EXISTS "proxy_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "execution_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "project_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "proxy_tokens" ADD CONSTRAINT "proxy_tokens_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "proxy_tokens" ADD CONSTRAINT "proxy_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "idx_proxy_tokens_token_hash" ON "proxy_tokens" USING btree ("token_hash");
CREATE INDEX "idx_proxy_tokens_expires_at" ON "proxy_tokens" USING btree ("expires_at");
CREATE INDEX "idx_proxy_tokens_execution_id" ON "proxy_tokens" USING btree ("execution_id");

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "provider_config" jsonb;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "provider_config" jsonb;
