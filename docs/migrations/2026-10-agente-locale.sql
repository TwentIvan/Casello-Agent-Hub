-- Migrazione di produzione: agente locale (spec 2026-10-27-casello-agente-locale-design.md §3).
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-agente-locale.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione continua a funzionare.

-- Un valore di enum non si può aggiungere dentro una transazione e usare subito: va fuori da BEGIN/COMMIT
ALTER TYPE "public"."provider_protocol" ADD VALUE IF NOT EXISTS 'local_agent' BEFORE 'unknown';

BEGIN;

DO $$ BEGIN CREATE TYPE "public"."local_job_kind" AS ENUM('analysis', 'run'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."local_job_status" AS ENUM('queued', 'waiting_choice', 'postponed', 'claimed', 'running', 'paused', 'completed', 'failed', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."local_claimed_by" AS ENUM('runner', 'chat'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."local_job_origin" AS ENUM('console', 'app'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."local_offline_policy" AS ENUM('fallback', 'wait_then_fallback', 'postpone'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "local_machines" (
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

CREATE TABLE IF NOT EXISTS "mcp_tokens" (
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

CREATE TABLE IF NOT EXISTS "local_jobs" (
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

CREATE INDEX IF NOT EXISTS "local_jobs_machine_status_idx" ON "local_jobs" USING btree ("machine_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "local_jobs_job_token_hash_unique" ON "local_jobs" USING btree ("job_token_hash") WHERE "local_jobs"."job_token_hash" is not null;

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "fallback_ai_model_id" integer;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "local_offline_policy" "local_offline_policy" DEFAULT 'fallback' NOT NULL;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "local_offline_wait_s" integer DEFAULT 30 NOT NULL;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "local_for_third_parties" boolean DEFAULT false NOT NULL;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "fallback_ai_model_id" integer;
DO $$ BEGIN ALTER TABLE "agents" ADD CONSTRAINT "agents_fallback_ai_model_id_ai_models_id_fk" FOREIGN KEY ("fallback_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "analyses" ADD CONSTRAINT "analyses_fallback_ai_model_id_ai_models_id_fk" FOREIGN KEY ("fallback_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nessuna riga in providers: il valore 'local_agent' dell'enum si aggiunge qui e non si usa nello stesso script
-- (l'editor SQL può eseguirlo in un'unica transazione). La riga del provider la crea all'avvio
-- ensureProviderRegistry, dal registro nel codice (lib/catalog/provider-registry-data.ts).

COMMIT;
