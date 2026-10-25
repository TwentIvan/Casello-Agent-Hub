CREATE TYPE "public"."app_status" AS ENUM('active', 'inactive');
CREATE TYPE "public"."agent_status" AS ENUM('active', 'inactive', 'draft');
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'awaiting_client', 'cancelled');
CREATE TYPE "public"."tool_kind" AS ENUM('http', 'ui', 'composite');
CREATE TYPE "public"."tool_identity" AS ENUM('user', 'service');
CREATE TYPE "public"."tool_status" AS ENUM('draft', 'active', 'disabled');
CREATE TYPE "public"."agent_role" AS ENUM('general', 'area');
CREATE TYPE "public"."source_type" AS ENUM('github', 'zip', 'none');
CREATE TYPE "public"."analysis_status" AS ENUM('queued', 'running', 'completed', 'failed', 'interrupted');
CREATE TYPE "public"."analysis_chapter" AS ENUM('tool', 'agent', 'skill', 'endpoint', 'completion', 'evolution');
CREATE TYPE "public"."item_diff" AS ENUM('new', 'changed', 'removed', 'unchanged');
CREATE TYPE "public"."item_status" AS ENUM('pending', 'approved', 'discarded', 'postponed');
CREATE TABLE "apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"base_url" text NOT NULL,
	"internal_base_url" text,
	"user_auth" jsonb,
	"service_auth" jsonb,
	"service_secret_enc" text,
	"source_type" "source_type" DEFAULT 'none' NOT NULL,
	"source_repo" text,
	"source_branch" text,
	"source_token_enc" text,
	"openapi_url" text,
	"functional_description" text,
	"status" "app_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "apps_slug_unique" UNIQUE("slug")
);

CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"name" text NOT NULL,
	"system_prompt" text,
	"model" text DEFAULT 'openrouter/auto' NOT NULL,
	"status" "agent_status" DEFAULT 'draft' NOT NULL,
	"role" "agent_role" DEFAULT 'area' NOT NULL,
	"area" text,
	"default_identity" "tool_identity" DEFAULT 'user' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "app_tools" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "tool_kind" NOT NULL,
	"identity" "tool_identity" DEFAULT 'user' NOT NULL,
	"requires_confirmation" boolean DEFAULT false NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"status" "tool_status" DEFAULT 'draft' NOT NULL,
	"params_schema" jsonb DEFAULT '{"type":"object","properties":{}}'::jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"evidence" jsonb,
	"needs_verification" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_tools_app_id_name_unique" UNIQUE("app_id","name")
);

CREATE TABLE "agent_tools" (
	"agent_id" integer NOT NULL,
	"tool_id" integer NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);

CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"input" text,
	"output" text,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"pending_action" jsonb,
	"loop_state" jsonb,
	"paused_at" timestamp,
	"prompt_tokens" integer,
	"completion_tokens" integer
);

CREATE TABLE "run_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"tool_name" text,
	"args" jsonb,
	"ok" boolean,
	"http_status" integer,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "agents" ADD CONSTRAINT "agents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app_tools" ADD CONSTRAINT "app_tools_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_tool_id_app_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."app_tools"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "agents_one_general_per_app" ON "agents" USING btree ("app_id") WHERE "agents"."role" = 'general';
CREATE INDEX "run_steps_run_id_position_idx" ON "run_steps" USING btree ("run_id","position");

CREATE TABLE "analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"model" text NOT NULL,
	"status" "analysis_status" DEFAULT 'queued' NOT NULL,
	"sources" jsonb NOT NULL,
	"max_tokens" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"phase" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"architecture_map" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "analyses_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "analysis_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"analysis_id" integer NOT NULL,
	"chapter" "analysis_chapter" NOT NULL,
	"ref" text NOT NULL,
	"position" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"diff" "item_diff" NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "item_status" DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_items_analysis_id_ref_unique" UNIQUE("analysis_id","ref"),
	CONSTRAINT "analysis_items_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "agent_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"instructions" text NOT NULL,
	"tool_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params_schema" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_agent_id_name_unique" UNIQUE("agent_id","name"),
	CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX "analyses_one_active_per_app" ON "analyses" USING btree ("app_id") WHERE "analyses"."status" in ('queued', 'running');

CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);

CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");
