-- Migrazione di produzione: fase 3 (l'architetto).
-- Sorgenti dell'app (codice, OpenAPI, descrizione funzionale), analisi dell'architetto, elementi della
-- proposta e skill degli agenti.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-fase-3.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore). Idempotente: una seconda esecuzione non cambia nulla.

BEGIN;

-- Enum ------------------------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE "public"."source_type" AS ENUM('github', 'zip', 'none'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."analysis_status" AS ENUM('queued', 'running', 'completed', 'failed', 'interrupted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."analysis_chapter" AS ENUM('tool', 'agent', 'skill', 'endpoint', 'completion', 'evolution'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."item_diff" AS ENUM('new', 'changed', 'removed', 'unchanged'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."item_status" AS ENUM('pending', 'approved', 'discarded', 'postponed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- apps ------------------------------------------------------------------------------------------
-- Le app esistenti partono con source_type = 'none' tramite il default.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "source_type" "source_type" DEFAULT 'none' NOT NULL;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "source_repo" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "source_branch" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "source_token_enc" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "openapi_url" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "functional_description" text;

-- Nuove tabelle ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "analyses" (
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

CREATE TABLE IF NOT EXISTS "analysis_items" (
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

CREATE TABLE IF NOT EXISTS "agent_skills" (
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

-- Un'analisi alla volta per app
CREATE UNIQUE INDEX IF NOT EXISTS "analyses_one_active_per_app" ON "analyses" USING btree ("app_id") WHERE "status" in ('queued', 'running');

COMMIT;
