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
CREATE TYPE "public"."identity_provider" AS ENUM('google', 'github');
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
	"source_installation_id" bigint,
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

CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"picture" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE "user_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text,
	"username" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_provider_user_unique" UNIQUE("provider","provider_user_id"),
	CONSTRAINT "user_identities_user_provider_unique" UNIQUE("user_id","provider"),
	CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "github_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_user_installation_unique" UNIQUE("user_id","installation_id"),
	CONSTRAINT "github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

-- Provider AI: dati allineati all'avvio dal registro nel codice; qui i provider usati dagli account esistenti
CREATE TYPE "public"."provider_protocol" AS ENUM('openai_compatible', 'anthropic', 'bedrock', 'vertex', 'azure', 'local_agent', 'unknown');
CREATE TYPE "public"."provider_status" AS ENUM('managed', 'coming', 'unmanaged');
CREATE TYPE "public"."provider_origin" AS ENUM('registry', 'discovered');

CREATE TABLE "providers" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" "provider_protocol" NOT NULL,
	"default_base_url" text,
	"source_keys" jsonb NOT NULL,
	"status" "provider_status" NOT NULL,
	"origin" "provider_origin" NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

INSERT INTO "providers" ("slug", "name", "protocol", "default_base_url", "source_keys", "status", "origin") VALUES
	('deepseek', 'DeepSeek', 'openai_compatible', 'https://api.deepseek.com/v1', '{"litellm": ["deepseek"], "openrouterAuthor": "deepseek"}', 'managed', 'registry'),
	('openrouter', 'OpenRouter', 'openai_compatible', 'https://openrouter.ai/api/v1', '{"litellm": ["openrouter"], "openrouterAuthor": null}', 'managed', 'registry'),
	('huggingface', 'Hugging Face', 'openai_compatible', 'https://router.huggingface.co/v1', '{"litellm": ["huggingface"], "openrouterAuthor": null}', 'managed', 'registry'),
	('mistral', 'Mistral', 'openai_compatible', 'https://api.mistral.ai/v1', '{"litellm": ["mistral", "codestral", "text-completion-codestral"], "openrouterAuthor": "mistralai"}', 'managed', 'registry'),
	('groq', 'Groq', 'openai_compatible', 'https://api.groq.com/openai/v1', '{"litellm": ["groq"], "openrouterAuthor": null}', 'managed', 'registry'),
	('together', 'Together AI', 'openai_compatible', 'https://api.together.xyz/v1', '{"litellm": ["together_ai"], "openrouterAuthor": null}', 'managed', 'registry'),
	('gemini', 'Google Gemini', 'openai_compatible', 'https://generativelanguage.googleapis.com/v1beta/openai', '{"litellm": ["gemini"], "openrouterAuthor": "google"}', 'managed', 'registry'),
	('custom', 'Personalizzato (compatibile OpenAI)', 'openai_compatible', NULL, '{"litellm": [], "openrouterAuthor": null}', 'managed', 'registry'),
	('system_gateway', 'Gateway di Casello', 'openai_compatible', NULL, '{"litellm": [], "openrouterAuthor": null}', 'managed', 'registry');

-- Account AI
CREATE TYPE "public"."ai_account_status" AS ENUM('unverified', 'ok', 'error');
CREATE TYPE "public"."ai_model_availability" AS ENUM('available', 'unavailable', 'unknown');
CREATE TYPE "public"."model_catalog_status" AS ENUM('available', 'deprecated', 'retired');
CREATE TYPE "public"."catalog_trigger" AS ENUM('scheduled', 'manual');
CREATE TYPE "public"."catalog_run_status" AS ENUM('running', 'completed', 'partial', 'failed');

-- user_id è null solo per l'account di sistema (gateway di Casello)
CREATE TABLE "ai_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "ai_account_status" DEFAULT 'unverified' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "ai_accounts_provider_providers_slug_fk" FOREIGN KEY ("provider") REFERENCES "public"."providers"("slug") ON DELETE no action ON UPDATE cascade
);

CREATE UNIQUE INDEX "ai_accounts_one_default_per_user" ON "ai_accounts" USING btree ("user_id") WHERE "ai_accounts"."is_default";

CREATE TABLE "ai_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"context_tokens" integer,
	"price_input_per_mtok" numeric(12, 6),
	"price_output_per_mtok" numeric(12, 6),
	"price_source" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"discovered" boolean DEFAULT false NOT NULL,
	"availability" "ai_model_availability" DEFAULT 'unknown' NOT NULL,
	"supports_tools" boolean,
	"offer_id" integer,
	"last_probe_at" timestamp,
	"last_probe_ok" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_models_account_model_unique" UNIQUE("account_id","model_id"),
	CONSTRAINT "ai_models_account_id_ai_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ai_accounts"("id") ON DELETE cascade ON UPDATE no action
);

-- Le righe esistenti restano con ai_model_id e cost_usd null; agents.model (testo) resta durante la transizione.
ALTER TABLE "agents" ADD COLUMN "ai_model_id" integer;
ALTER TABLE "analyses" ADD COLUMN "ai_model_id" integer;
ALTER TABLE "analyses" ADD COLUMN "cost_usd" numeric(12, 6);
ALTER TABLE "runs" ADD COLUMN "cost_usd" numeric(12, 6);

ALTER TABLE "agents" ADD CONSTRAINT "agents_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;

-- Catalogo universale: modelli indipendenti dal provider e loro offerte presso i provider
CREATE TYPE "public"."model_mode" AS ENUM('chat', 'embedding', 'image_generation', 'image_edit', 'audio_transcription', 'audio_speech', 'video_generation', 'rerank', 'moderation', 'ocr', 'search', 'realtime', 'responses', 'completion', 'other');

CREATE TABLE "models" (
	"id" serial PRIMARY KEY NOT NULL,
	"canonical_key" text NOT NULL,
	"author" text NOT NULL,
	"family" text NOT NULL,
	"version" text NOT NULL,
	"mode" "model_mode" DEFAULT 'chat' NOT NULL,
	"supports_tools" boolean,
	"supports_vision" boolean,
	"supports_reasoning" boolean,
	"released_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "models_canonical_key_unique" UNIQUE("canonical_key")
);

CREATE TABLE "model_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"price_input_per_mtok" numeric(12, 6),
	"price_output_per_mtok" numeric(12, 6),
	"context_tokens" integer,
	"supports_tools" boolean,
	"status" "model_catalog_status" DEFAULT 'available' NOT NULL,
	"deprecation_date" timestamp,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_offers_provider_model_unique" UNIQUE("provider","provider_model_id"),
	CONSTRAINT "model_offers_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "model_offers_provider_providers_slug_fk" FOREIGN KEY ("provider") REFERENCES "public"."providers"("slug") ON DELETE no action ON UPDATE cascade
);

CREATE INDEX "model_offers_model_id_idx" ON "model_offers" USING btree ("model_id");

-- user_id è null per le esecuzioni pianificate
CREATE TABLE "catalog_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"trigger" "catalog_trigger" NOT NULL,
	"user_id" integer,
	"status" "catalog_run_status" NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"summary" jsonb,
	"error" text,
	CONSTRAINT "catalog_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);

-- Al massimo un aggiornamento del catalogo in corso alla volta
CREATE UNIQUE INDEX "catalog_runs_one_running" ON "catalog_runs" USING btree ("status") WHERE "catalog_runs"."status" = 'running';

ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_offer_id_model_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."model_offers"("id") ON DELETE set null ON UPDATE no action;

-- Agente locale: macchine, lavori, token personali e riserva
CREATE TYPE "public"."local_job_kind" AS ENUM('analysis', 'run');
CREATE TYPE "public"."local_job_status" AS ENUM('queued', 'waiting_choice', 'postponed', 'claimed', 'running', 'paused', 'completed', 'failed', 'cancelled');
CREATE TYPE "public"."local_claimed_by" AS ENUM('runner', 'chat');
CREATE TYPE "public"."local_job_origin" AS ENUM('console', 'app');
CREATE TYPE "public"."local_offline_policy" AS ENUM('fallback', 'wait_then_fallback', 'postpone');

CREATE TABLE "local_machines" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "local_machines_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "local_machines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "mcp_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "local_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"machine_id" integer NOT NULL,
	"kind" "local_job_kind" NOT NULL,
	"analysis_id" integer,
	"run_id" integer,
	"status" "local_job_status" DEFAULT 'queued' NOT NULL,
	"origin" "local_job_origin" NOT NULL,
	"fallback_ai_model_id" integer,
	"claude_session_id" text,
	"claimed_by" "local_claimed_by",
	"current_item" jsonb,
	"job_token_hash" text,
	"job_token_expires_at" timestamp,
	"heartbeat_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "local_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "local_jobs_machine_id_local_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."local_machines"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "local_jobs_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "local_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "local_jobs_fallback_ai_model_id_ai_models_id_fk" FOREIGN KEY ("fallback_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);

CREATE INDEX "local_jobs_machine_status_idx" ON "local_jobs" USING btree ("machine_id","status");
CREATE UNIQUE INDEX "local_jobs_job_token_hash_unique" ON "local_jobs" USING btree ("job_token_hash") WHERE "local_jobs"."job_token_hash" is not null;

ALTER TABLE "agents" ADD COLUMN "fallback_ai_model_id" integer;
ALTER TABLE "agents" ADD COLUMN "local_offline_policy" "local_offline_policy" DEFAULT 'fallback' NOT NULL;
ALTER TABLE "agents" ADD COLUMN "local_offline_wait_s" integer DEFAULT 30 NOT NULL;
ALTER TABLE "agents" ADD COLUMN "local_for_third_parties" boolean DEFAULT false NOT NULL;
ALTER TABLE "analyses" ADD COLUMN "fallback_ai_model_id" integer;
ALTER TABLE "agents" ADD CONSTRAINT "agents_fallback_ai_model_id_ai_models_id_fk" FOREIGN KEY ("fallback_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_fallback_ai_model_id_ai_models_id_fk" FOREIGN KEY ("fallback_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
