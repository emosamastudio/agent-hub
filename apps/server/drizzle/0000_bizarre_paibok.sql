CREATE TYPE "public"."execution_status" AS ENUM('queued', 'running', 'success', 'failed', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."trace_role" AS ENUM('system', 'user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('cron', 'manual', 'api', 'agent', 'retry');--> statement-breakpoint
CREATE TABLE "agent_cooldowns" (
	"agent_name" text NOT NULL,
	"cooldown_key" text NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"run_count" integer DEFAULT 0,
	CONSTRAINT "agent_cooldowns_agent_name_cooldown_key_pk" PRIMARY KEY("agent_name","cooldown_key")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"agent_type" text NOT NULL,
	"cron_expression" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"misfire_policy" text DEFAULT 'fire_once' NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"max_pending_queue" integer DEFAULT 100 NOT NULL,
	"timeout_seconds" integer DEFAULT 600 NOT NULL,
	"retry_max" integer DEFAULT 3 NOT NULL,
	"retry_backoff_base_ms" integer DEFAULT 30000 NOT NULL,
	"max_turns" integer,
	"max_cost_usd" numeric(10, 6),
	"handler_name" text,
	"executor_host" text,
	"executor_status" text DEFAULT 'offline' NOT NULL,
	"input_schema" jsonb,
	"allow_trigger_by" jsonb,
	"idempotency_window_seconds" integer DEFAULT 3600 NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb,
	"last_heartbeat_at" timestamp with time zone,
	"last_execution_at" timestamp with time zone,
	"active_execution_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_name" text NOT NULL,
	"severity" text NOT NULL,
	"agent_id" uuid,
	"message" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger_type" "trigger_type" NOT NULL,
	"triggered_by" text,
	"parent_execution_id" uuid,
	"root_execution_id" uuid,
	"trigger_depth" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"status" "execution_status" DEFAULT 'queued' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"last_activity_at" timestamp with time zone,
	"input_payload" jsonb,
	"result_summary" text,
	"result_data" jsonb,
	"error_message" text,
	"error_stack" text,
	"trace_count_expected" integer,
	"trace_count_actual" integer DEFAULT 0,
	"trace_incomplete" boolean DEFAULT false,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_of" uuid,
	"executor_host" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"workspace_path" text,
	"status" text DEFAULT 'active' NOT NULL,
	"api_key_hash" text,
	"dashboard_password_hash" text,
	"allow_trigger_from" text[] DEFAULT '{}',
	"trigger_rate_limit_per_sec" integer DEFAULT 50,
	"cost_config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "provider_pricing" (
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_cost_per_1k" numeric(10, 6) NOT NULL,
	"output_cost_per_1k" numeric(10, 6) NOT NULL,
	"effective_from" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"span_index" integer DEFAULT 0 NOT NULL,
	"parent_span_id" uuid,
	"role" "trace_role" NOT NULL,
	"span_type" text DEFAULT 'llm' NOT NULL,
	"model" text,
	"provider" text,
	"input_content" text,
	"output_content" text,
	"tool_calls" jsonb,
	"tool_results" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_estimate" numeric(10, 6),
	"latency_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_log" ADD CONSTRAINT "alert_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agents_project_name" ON "agents" USING btree ("project_id","name");