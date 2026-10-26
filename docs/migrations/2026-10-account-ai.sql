-- Migrazione di produzione: Account AI (ogni utente configura i propri provider e modelli).
-- Nuove tabelle ai_accounts e ai_models, collegamento modello su agents e analyses, costo in USD su analyses e runs.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-account-ai.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore). Idempotente: una seconda esecuzione non cambia nulla.

BEGIN;

-- Enum ------------------------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE "public"."ai_provider" AS ENUM('deepseek', 'openrouter', 'huggingface', 'mistral', 'groq', 'together', 'custom', 'system_gateway'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."ai_account_status" AS ENUM('unverified', 'ok', 'error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nuove tabelle ---------------------------------------------------------------------------------
-- user_id è null solo per l'account di sistema (gateway di Casello)
CREATE TABLE IF NOT EXISTS "ai_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" text NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "ai_account_status" DEFAULT 'unverified' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_accounts_one_default_per_user" ON "ai_accounts" USING btree ("user_id") WHERE "ai_accounts"."is_default";

CREATE TABLE IF NOT EXISTS "ai_models" (
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_models_account_model_unique" UNIQUE("account_id","model_id"),
	CONSTRAINT "ai_models_account_id_ai_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ai_accounts"("id") ON DELETE cascade ON UPDATE no action
);

-- Colonne nuove su tabelle esistenti ------------------------------------------------------------
-- Le righe esistenti restano con ai_model_id e cost_usd null; agents.model (testo) resta durante la transizione.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "ai_model_id" integer;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "ai_model_id" integer;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 6);
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 6);

DO $$ BEGIN ALTER TABLE "agents" ADD CONSTRAINT "agents_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "analyses" ADD CONSTRAINT "analyses_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
