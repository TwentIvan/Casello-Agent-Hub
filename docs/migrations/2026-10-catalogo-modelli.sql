-- Migrazione di produzione: catalogo dei modelli (model_catalog), esecuzioni dell'aggiornamento (catalog_runs),
-- provider Gemini e nuovi campi di ai_models (disponibilità, tool, collegamento al catalogo, prova).
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-catalogo-modelli.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore). Idempotente: una seconda esecuzione non cambia nulla.

-- ADD VALUE sta fuori dalla transazione: un valore nuovo di un enum non si può usare nella stessa transazione
ALTER TYPE "public"."ai_provider" ADD VALUE IF NOT EXISTS 'gemini';

BEGIN;

-- Enum ------------------------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE "public"."ai_model_availability" AS ENUM('available', 'unavailable', 'unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."model_catalog_status" AS ENUM('available', 'deprecated', 'retired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."catalog_trigger" AS ENUM('scheduled', 'manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."catalog_run_status" AS ENUM('running', 'completed', 'partial', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nuove tabelle ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "model_catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"model_id" text NOT NULL,
	"family" text NOT NULL,
	"version" text NOT NULL,
	"released_at" timestamp,
	"price_input_per_mtok" numeric(12, 6),
	"price_output_per_mtok" numeric(12, 6),
	"context_tokens" integer,
	"supports_tools" boolean,
	"status" "model_catalog_status" DEFAULT 'available' NOT NULL,
	"deprecation_date" timestamp,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_provider_model_unique" UNIQUE("provider","model_id")
);

-- user_id è null per le esecuzioni pianificate
CREATE TABLE IF NOT EXISTS "catalog_runs" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_runs_one_running" ON "catalog_runs" USING btree ("status") WHERE "catalog_runs"."status" = 'running';

-- Colonne nuove su ai_models ---------------------------------------------------------------------
-- I modelli esistenti restano con availability 'unknown' e senza collegamento al catalogo.
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "availability" "ai_model_availability" DEFAULT 'unknown' NOT NULL;
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "supports_tools" boolean;
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "catalog_id" integer;
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "last_probe_at" timestamp;
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "last_probe_ok" boolean;

DO $$ BEGIN ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_catalog_id_model_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
