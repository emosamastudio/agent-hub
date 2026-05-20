CREATE INDEX "idx_projects_api_key_hash" ON "projects" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "idx_executions_status_scheduled_at" ON "executions" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_executions_agent_status" ON "executions" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_executions_agent_idempotency_created_at" ON "executions" USING btree ("agent_id","idempotency_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_executions_retry_of" ON "executions" USING btree ("retry_of");--> statement-breakpoint
CREATE INDEX "idx_traces_execution_id" ON "traces" USING btree ("execution_id");
