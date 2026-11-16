-- Lucius e le best practice (Botcave): modalità e fonti curate dell'utente, interruttore per conversazione e per analisi,
-- cache e registro dei costi delle ricerche. Additiva e idempotente, niente `-post`: la applica il deploy.

DO $$ BEGIN
  CREATE TYPE "public"."best_practice_mode" AS ENUM('always', 'on_request');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lucius_best_practice" "best_practice_mode" DEFAULT 'on_request' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lucius_search_ai_model_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lucius_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_lucius_search_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_lucius_search_ai_model_id_ai_models_id_fk" FOREIGN KEY ("lucius_search_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

ALTER TABLE "plan_conversations" ADD COLUMN IF NOT EXISTS "best_practice" boolean DEFAULT false NOT NULL;
ALTER TABLE "character_conversations" ADD COLUMN IF NOT EXISTS "best_practice" boolean DEFAULT false NOT NULL;
ALTER TABLE "team_chat_conversations" ADD COLUMN IF NOT EXISTS "best_practice" boolean DEFAULT false NOT NULL;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "best_practice" boolean DEFAULT false NOT NULL;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "best_practice_notes" text;

CREATE TABLE IF NOT EXISTS "best_practice_searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"analysis_id" integer,
	"query_hash" text NOT NULL,
	"query" text NOT NULL,
	"answer" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_model_id" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"search_queries" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"cached_from" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "best_practice_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "best_practice_searches_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "best_practice_searches_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "best_practice_searches_cached_from_best_practice_searches_id_fk" FOREIGN KEY ("cached_from") REFERENCES "public"."best_practice_searches"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "best_practice_searches_lookup_idx" ON "best_practice_searches" USING btree ("user_id", "query_hash", "created_at");
