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
CREATE TYPE "public"."provider_protocol" AS ENUM('openai_compatible', 'anthropic', 'bedrock', 'vertex', 'azure', 'unknown');
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
	('custom', 'Personalizzato (compatibile OpenAI)', 'openai_compatible', NULL, '{"litellm": [], "openrouterAuthor": null}', 'managed', 'registry');

-- Account AI
CREATE TYPE "public"."ai_account_status" AS ENUM('unverified', 'ok', 'error');
CREATE TYPE "public"."ai_model_availability" AS ENUM('available', 'unavailable', 'unknown');
CREATE TYPE "public"."model_catalog_status" AS ENUM('available', 'deprecated', 'retired');
CREATE TYPE "public"."catalog_trigger" AS ENUM('scheduled', 'manual');
CREATE TYPE "public"."catalog_run_status" AS ENUM('running', 'completed', 'partial', 'failed');

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

-- Token in cache: letti dall'uso del provider, pesati al 10% nel budget dell'architetto e pagati al prezzo di cache
ALTER TABLE "analyses" ADD COLUMN "cached_tokens" integer DEFAULT 0 NOT NULL;
ALTER TABLE "runs" ADD COLUMN "cached_tokens" integer DEFAULT 0 NOT NULL;
ALTER TABLE "ai_models" ADD COLUMN "price_cached_input_per_mtok" numeric(12, 6);
ALTER TABLE "model_offers" ADD COLUMN "price_cached_input_per_mtok" numeric(12, 6);

-- Esecutore locale dell'architetto: esecutore e lease dell'analisi, esiti per fase, token personali
CREATE TYPE "public"."analysis_executor" AS ENUM('cloud', 'local');
ALTER TABLE "analyses" ADD COLUMN "executor" "analysis_executor" DEFAULT 'cloud' NOT NULL;
ALTER TABLE "analyses" ADD COLUMN "lease_token_hash" text;
ALTER TABLE "analyses" ADD COLUMN "lease_until" timestamp;
ALTER TABLE "analyses" ADD COLUMN "lease_label" text;
ALTER TABLE "analyses" ADD COLUMN "source_commit" text;

CREATE TABLE "analysis_phase_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"analysis_id" integer NOT NULL,
	"phase" text NOT NULL,
	"result" jsonb NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_phase_results_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX "analysis_phase_results_unique" ON "analysis_phase_results" USING btree ("analysis_id", "phase");

CREATE TYPE "public"."node_status" AS ENUM('active', 'disabled');
CREATE TABLE "nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" "node_status" DEFAULT 'active' NOT NULL,
	"executor" text,
	"version" text,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"workspace_root" text,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"workspace_folders" jsonb,
	"folders_updated_at" timestamp,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_user_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE TABLE "api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"scopes" text[] DEFAULT '{mcp}' NOT NULL,
	"node_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_tokens_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

-- Chat del piano: conversazioni con il bot sul piano di un'app, messaggi, proposte da accettare o rifiutare
CREATE TYPE "public"."plan_turn_status" AS ENUM('idle', 'running');
CREATE TYPE "public"."plan_message_role" AS ENUM('user', 'assistant');
CREATE TYPE "public"."plan_proposal_kind" AS ENUM('add', 'update', 'discard');
CREATE TYPE "public"."plan_proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'stale');
CREATE TYPE "public"."item_origin" AS ENUM('architect', 'chat');

CREATE TABLE "plan_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"analysis_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"ai_model_id" integer,
	"title" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"turn_status" "plan_turn_status" DEFAULT 'idle' NOT NULL,
	"summarized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_conversations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_conversations_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "plan_conversations_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX "plan_conversations_app_user_idx" ON "plan_conversations" USING btree ("app_id", "user_id");

CREATE TABLE "plan_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "plan_message_role" NOT NULL,
	"content" text NOT NULL,
	"error" boolean DEFAULT false NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_messages_conversation_id_plan_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."plan_conversations"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX "plan_messages_conversation_idx" ON "plan_messages" USING btree ("conversation_id", "id");

-- Voci del piano: origine e conversazione che le ha create o modificate
ALTER TABLE "analysis_items" ADD COLUMN "origin" "item_origin" DEFAULT 'architect' NOT NULL;
ALTER TABLE "analysis_items" ADD COLUMN "conversation_id" integer;
ALTER TABLE "analysis_items" ADD CONSTRAINT "analysis_items_conversation_id_plan_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."plan_conversations"("id") ON DELETE set null ON UPDATE no action;

CREATE TABLE "plan_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"kind" "plan_proposal_kind" NOT NULL,
	"chapter" "analysis_chapter" NOT NULL,
	"payload" jsonb,
	"rationale" text NOT NULL,
	"target_item_id" integer,
	"target_hash" text,
	"status" "plan_proposal_status" DEFAULT 'pending' NOT NULL,
	"item_id" integer,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_proposals_conversation_id_plan_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."plan_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_proposals_message_id_plan_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."plan_messages"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_proposals_target_item_id_analysis_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."analysis_items"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "plan_proposals_item_id_analysis_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."analysis_items"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX "plan_proposals_conversation_idx" ON "plan_proposals" USING btree ("conversation_id");

-- Tetti di spesa mensili (USD, null = nessun limite) e modello con cui è partita ogni run
ALTER TABLE "users" ADD COLUMN "monthly_budget_usd" numeric(12, 2);
ALTER TABLE "agents" ADD COLUMN "monthly_budget_usd" numeric(12, 2);
ALTER TABLE "runs" ADD COLUMN "ai_model_id" integer;
ALTER TABLE "runs" ADD CONSTRAINT "runs_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "runs_ai_model_created_idx" ON "runs" USING btree ("ai_model_id", "created_at");
CREATE INDEX "runs_agent_created_idx" ON "runs" USING btree ("agent_id", "created_at");

-- Tetti di spesa mensili per modello AI e per account AI (USD, null = nessun limite)
ALTER TABLE "ai_models" ADD COLUMN "monthly_budget_usd" numeric(12, 2);
ALTER TABLE "ai_accounts" ADD COLUMN "monthly_budget_usd" numeric(12, 2);

-- Collegamento delle voci del piano alle issue GitHub (`issue_state`: creating | open | closed)
ALTER TABLE "analysis_items" ADD COLUMN "issue_repo" text;
ALTER TABLE "analysis_items" ADD COLUMN "issue_number" integer;
ALTER TABLE "analysis_items" ADD COLUMN "issue_url" text;
ALTER TABLE "analysis_items" ADD COLUMN "issue_state" text;
ALTER TABLE "analysis_items" ADD COLUMN "issue_state_reason" text;
ALTER TABLE "analysis_items" ADD COLUMN "issue_created_at" timestamp;
ALTER TABLE "analysis_items" ADD COLUMN "issue_checked_at" timestamp;
CREATE INDEX "analysis_items_issue_idx" ON "analysis_items" USING btree ("issue_repo", "issue_number") WHERE "issue_number" IS NOT NULL;

-- Modello predefinito dell'utente per gli agenti che Casello crea (null = nessuno)
ALTER TABLE "users" ADD COLUMN "default_ai_model_id" integer;
ALTER TABLE "users" ADD CONSTRAINT "users_default_ai_model_id_ai_models_id_fk" FOREIGN KEY ("default_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;

-- Strumenti MCP, livelli d'azione e coda delle azioni da confermare
ALTER TYPE "public"."tool_kind" ADD VALUE 'mcp';
CREATE TYPE "public"."tool_level" AS ENUM('L0', 'L1', 'L2', 'L3');
CREATE TYPE "public"."pending_action_status" AS ENUM('pending', 'executing', 'done', 'failed', 'rejected');
ALTER TABLE "app_tools" ADD COLUMN "level" "tool_level" DEFAULT 'L2' NOT NULL;
ALTER TABLE "app_tools" ADD COLUMN "level_override" "tool_level";
ALTER TABLE "apps" ADD COLUMN "mcp_url" text;
CREATE TABLE "pending_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"number" integer NOT NULL,
	"app_id" integer NOT NULL,
	"tool_id" integer NOT NULL,
	"run_id" integer,
	"agent_id" integer,
	"args_enc" text NOT NULL,
	"args_public" jsonb NOT NULL,
	"recipient" text NOT NULL,
	"summary" text NOT NULL,
	"status" "pending_action_status" DEFAULT 'pending' NOT NULL,
	"result" text,
	"error_message" text,
	"decided_by" integer,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "pending_actions_user_number_unique" UNIQUE("user_id","number"),
	CONSTRAINT "pending_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pending_actions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pending_actions_tool_id_app_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."app_tools"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "pending_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "pending_actions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "pending_actions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX "pending_actions_user_status_idx" ON "pending_actions" USING btree ("user_id", "status");
CREATE TYPE "public"."skill_kind" AS ENUM('casello', 'node');
CREATE TYPE "public"."team_instance_status" AS ENUM('draft', 'active', 'closed');
CREATE TABLE "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" "skill_kind" NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"deprecated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skills_code_unique" UNIQUE("code")
);
CREATE TABLE "skill_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"tool_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_version_unique" UNIQUE("skill_id","version"),
	CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action
);
CREATE TABLE "team_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "team_templates_name_active_unique" ON "team_templates" USING btree ("name") WHERE "team_templates"."archived" = false;
CREATE TABLE "team_template_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_template_versions_template_version_unique" UNIQUE("template_id","version"),
	CONSTRAINT "team_template_versions_template_id_team_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."team_templates"("id") ON DELETE cascade ON UPDATE no action
);
CREATE TABLE "team_instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"template_id" integer,
	"template_version" integer,
	"ref_app_id" integer NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"ref_title" text NOT NULL,
	"status" "team_instance_status" DEFAULT 'draft' NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"node_workspace" text,
	CONSTRAINT "team_instances_template_id_team_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."team_templates"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "team_instances_ref_app_id_apps_id_fk" FOREIGN KEY ("ref_app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "team_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX "team_instances_ref_idx" ON "team_instances" USING btree ("ref_app_id", "ref_type", "ref_id");
CREATE TABLE "team_instance_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "skill_kind" NOT NULL,
	"content" text NOT NULL,
	"tool_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_instance_skills_instance_code_unique" UNIQUE("instance_id","code"),
	CONSTRAINT "team_instance_skills_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action
);
-- Esecuzione delle squadre: PLAN versionato, compiti, turni del capo, eventi; nuove colonne su istanze, coda delle
-- conferme e utenti (additiva, idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_plan_status') THEN
    CREATE TYPE "public"."team_plan_status" AS ENUM('draft', 'proposed', 'approved');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_task_status') THEN
    CREATE TYPE "public"."team_task_status" AS ENUM('queued', 'running', 'waiting_node', 'done', 'blocked', 'failed', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_turn_status') THEN
    CREATE TYPE "public"."team_turn_status" AS ENUM('queued', 'running', 'done', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_event_type') THEN
    CREATE TYPE "public"."team_event_type" AS ENUM('piano_proposto', 'compito_finito', 'bloccato', 'decisione_richiesta', 'azione_manuale_richiesta', 'lavoro_finito', 'interrotto');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pending_action_kind') THEN
    CREATE TYPE "public"."pending_action_kind" AS ENUM('action', 'plan', 'plan_change');
  END IF;
END $$;

-- Colonne nuove su tabelle esistenti
ALTER TABLE "team_instances" ADD COLUMN IF NOT EXISTS "activated_by" integer;
ALTER TABLE "team_instances" ADD COLUMN IF NOT EXISTS "monthly_budget_usd" numeric(12, 2);
ALTER TABLE "team_instances" ADD COLUMN IF NOT EXISTS "last_turn_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "centralino_ai_model_id" integer;
ALTER TABLE "pending_actions" ADD COLUMN IF NOT EXISTS "kind" "pending_action_kind" DEFAULT 'action' NOT NULL;
ALTER TABLE "pending_actions" ADD COLUMN IF NOT EXISTS "team_instance_id" integer;
ALTER TABLE "pending_actions" ADD COLUMN IF NOT EXISTS "plan_version" integer;
ALTER TABLE "pending_actions" ALTER COLUMN "tool_id" DROP NOT NULL;
ALTER TABLE "pending_actions" ALTER COLUMN "app_id" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "team_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "team_plan_status" DEFAULT 'draft' NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manual_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_version" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_plans_instance_unique" UNIQUE("instance_id"),
	CONSTRAINT "team_plans_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action
);
CREATE TABLE IF NOT EXISTS "team_plan_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"version" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_plan_versions_instance_version_unique" UNIQUE("instance_id","version"),
	CONSTRAINT "team_plan_versions_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action
);
CREATE TABLE IF NOT EXISTS "team_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"plan_task_id" text NOT NULL,
	"role_key" text NOT NULL,
	"instructions" text NOT NULL,
	"status" "team_task_status" DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"detail" text,
	"error" text,
	"ai_model_id" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"node_id" integer,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"session_id" text,
	"waiting_since" timestamp,
	"no_node_notified" boolean DEFAULT false NOT NULL,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "team_tasks_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_tasks_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "team_tasks_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_tasks_node_status_idx" ON "team_tasks" USING btree ("node_id", "status");
CREATE INDEX IF NOT EXISTS "team_tasks_instance_status_idx" ON "team_tasks" USING btree ("instance_id", "status");
CREATE TABLE IF NOT EXISTS "team_task_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"tool_name" text,
	"args" jsonb,
	"ok" boolean,
	"http_status" integer,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_task_steps_task_id_team_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."team_tasks"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_task_steps_task_id_position_idx" ON "team_task_steps" USING btree ("task_id", "position");
CREATE TABLE IF NOT EXISTS "team_turns" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "team_turn_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"ai_model_id" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "team_turns_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_turns_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_turns_instance_status_idx" ON "team_turns" USING btree ("instance_id", "status");
-- Al più un turno in coda e uno in corso per istanza
CREATE UNIQUE INDEX IF NOT EXISTS "team_turns_one_queued_unique" ON "team_turns" USING btree ("instance_id") WHERE "team_turns"."status" = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS "team_turns_one_running_unique" ON "team_turns" USING btree ("instance_id") WHERE "team_turns"."status" = 'running';
CREATE TABLE IF NOT EXISTS "team_turn_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"turn_id" integer NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"tool_name" text,
	"args" jsonb,
	"ok" boolean,
	"http_status" integer,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_turn_steps_turn_id_team_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."team_turns"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_turn_steps_turn_id_position_idx" ON "team_turn_steps" USING btree ("turn_id", "position");
CREATE TABLE IF NOT EXISTS "team_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"type" "team_event_type" NOT NULL,
	"task_id" integer,
	"bulletin" text NOT NULL,
	"detail" text,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_events_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_events_task_id_team_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."team_tasks"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_events_instance_created_idx" ON "team_events" USING btree ("instance_id", "created_at");

-- Chiavi esterne e vincoli sulle tabelle esistenti (aggiunti solo se mancano)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_instances_activated_by_users_id_fk') THEN
    ALTER TABLE "team_instances" ADD CONSTRAINT "team_instances_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_centralino_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_centralino_ai_model_id_ai_models_id_fk" FOREIGN KEY ("centralino_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_actions_team_instance_id_team_instances_id_fk') THEN
    ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_team_instance_id_team_instances_id_fk" FOREIGN KEY ("team_instance_id") REFERENCES "public"."team_instances"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_actions_action_needs_tool_check') THEN
    ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_action_needs_tool_check" CHECK ("kind" <> 'action' OR ("tool_id" IS NOT NULL AND "app_id" IS NOT NULL));
  END IF;
END $$;

-- Nodo locale: allegati delle squadre (i nodi, le colonne di api_tokens, team_instances e team_tasks sono sopra)
CREATE TABLE "team_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" bytea NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "team_attachments_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX "team_attachments_instance_idx" ON "team_attachments" USING btree ("instance_id");

-- Connettore OAuth per l'app Claude
CREATE TYPE "public"."oauth_client_kind" AS ENUM('dcr', 'metadata');
CREATE TYPE "public"."oauth_token_kind" AS ENUM('access', 'refresh');

CREATE TABLE "oauth_clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"kind" "oauth_client_kind" NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"metadata_fetched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);

CREATE TABLE "oauth_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX "oauth_grants_active_unique" ON "oauth_grants" USING btree ("user_id","client_id") WHERE "oauth_grants"."revoked_at" IS NULL;

CREATE TABLE "oauth_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"grant_id" integer NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	CONSTRAINT "oauth_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX "oauth_codes_grant_idx" ON "oauth_codes" USING btree ("grant_id");

CREATE TABLE "oauth_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"grant_id" integer NOT NULL,
	"kind" "oauth_token_kind" NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");

-- Alfred (docs/migrations/2026-11-alfred.sql)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alfred_session_status') THEN
    CREATE TYPE "public"."alfred_session_status" AS ENUM('active', 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alfred_decision') THEN
    CREATE TYPE "public"."alfred_decision" AS ENUM('approve', 'reject');
  END IF;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_ai_model_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_voice" text;

CREATE TABLE IF NOT EXISTS "alfred_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ai_model_id" integer,
	"status" "alfred_session_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8),
	CONSTRAINT "alfred_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "alfred_sessions_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "alfred_sessions_user_status_idx" ON "alfred_sessions" USING btree ("user_id", "status");

CREATE TABLE IF NOT EXISTS "alfred_confirmations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"number" integer NOT NULL,
	"decision" "alfred_decision" NOT NULL,
	"note" text,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alfred_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "alfred_confirmations_session_id_alfred_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."alfred_sessions"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "alfred_confirmations_session_used_idx" ON "alfred_confirmations" USING btree ("session_id", "used_at");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_alfred_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_alfred_ai_model_id_ai_models_id_fk" FOREIGN KEY ("alfred_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

-- Lucius sulla squadra e memorie dei personaggi
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_chat_proposal_kind') THEN
    CREATE TYPE "public"."team_chat_proposal_kind" AS ENUM('role_identity', 'role_instructions');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'character') THEN
    CREATE TYPE "public"."character" AS ENUM('alfred', 'lucius');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'character_history_kind') THEN
    CREATE TYPE "public"."character_history_kind" AS ENUM('alfred_session', 'plan_conversation', 'team_chat');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "team_chat_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_instance_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"ai_model_id" integer,
	"title" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"turn_status" "plan_turn_status" DEFAULT 'idle' NOT NULL,
	"summarized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_chat_conversations_team_instance_id_team_instances_id_fk" FOREIGN KEY ("team_instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "team_chat_conversations_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_chat_conversations_team_user_idx" ON "team_chat_conversations" USING btree ("team_instance_id", "user_id");

CREATE TABLE IF NOT EXISTS "team_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "plan_message_role" NOT NULL,
	"content" text NOT NULL,
	"error" boolean DEFAULT false NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_chat_messages_conversation_id_team_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."team_chat_conversations"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_chat_messages_conversation_idx" ON "team_chat_messages" USING btree ("conversation_id", "id");

CREATE TABLE IF NOT EXISTS "team_chat_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"kind" "team_chat_proposal_kind" NOT NULL,
	"role_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"target_hash" text,
	"status" "plan_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_chat_proposals_conversation_id_team_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."team_chat_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_chat_proposals_message_id_team_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."team_chat_messages"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_chat_proposals_conversation_idx" ON "team_chat_proposals" USING btree ("conversation_id");

CREATE TABLE IF NOT EXISTS "character_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"content" text NOT NULL,
	"ref" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_notes_user_character_idx" ON "character_notes" USING btree ("user_id", "character");

CREATE TABLE IF NOT EXISTS "character_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"kind" "character_history_kind" NOT NULL,
	"ref_id" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"ai_model_id" integer,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "character_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "character_history_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_history_user_character_idx" ON "character_history" USING btree ("user_id", "character");
CREATE UNIQUE INDEX IF NOT EXISTS "character_history_ref_uniq" ON "character_history" USING btree ("user_id", "character", "kind", "ref_id");

-- Alfred e Lucius nelle aree
ALTER TYPE "public"."character_history_kind" ADD VALUE IF NOT EXISTS 'character_chat';

-- Colonne di users: modelli e tetti per personaggio
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_chat_ai_model_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lucius_ai_model_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_monthly_budget_usd" numeric(12, 2);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lucius_monthly_budget_usd" numeric(12, 2);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_alfred_chat_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_alfred_chat_ai_model_id_ai_models_id_fk" FOREIGN KEY ("alfred_chat_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_lucius_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_lucius_ai_model_id_ai_models_id_fk" FOREIGN KEY ("lucius_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "character_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"subject_title" text,
	"ai_model_id" integer,
	"title" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"turn_status" "plan_turn_status" DEFAULT 'idle' NOT NULL,
	"archived_at" timestamp,
	"summarized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_conversations_subject_type_check" CHECK ("subject_type" IN ('alfred_thread', 'agent', 'skill', 'team_template', 'area_agents', 'area_skills', 'area_team_templates')),
	CONSTRAINT "character_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "character_conversations_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_conversations_subject_idx" ON "character_conversations" USING btree ("user_id", "character", "subject_type", "subject_id");
CREATE UNIQUE INDEX IF NOT EXISTS "character_conversations_alfred_open_uniq" ON "character_conversations" USING btree ("user_id") WHERE "subject_type" = 'alfred_thread' AND "archived_at" IS NULL;

CREATE TABLE IF NOT EXISTS "character_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "plan_message_role" NOT NULL,
	"content" text NOT NULL,
	"error" boolean DEFAULT false NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"page_context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_messages_conversation_id_character_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."character_conversations"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_messages_conversation_idx" ON "character_messages" USING btree ("conversation_id", "id");

CREATE TABLE IF NOT EXISTS "character_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"target_hash" text,
	"status" "plan_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_proposals_kind_check" CHECK ("kind" IN ('agent_prompt', 'agent_tools', 'skill_content', 'template_roles', 'agent_create', 'skill_create', 'template_create', 'decision', 'handoff')),
	CONSTRAINT "character_proposals_conversation_id_character_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."character_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "character_proposals_message_id_character_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."character_messages"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_proposals_conversation_idx" ON "character_proposals" USING btree ("conversation_id");
