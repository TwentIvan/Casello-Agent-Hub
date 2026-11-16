-- Sintesi dell'architettura per App (Botcave): frequenza di aggiornamento sull'App, una riga di sintesi per App e lo storico
-- delle generazioni (versioni e costi). Additiva e idempotente, niente `-post`: la applica il deploy.

DO $$ BEGIN
  CREATE TYPE "public"."architecture_refresh" AS ENUM('off', 'hourly', '6h', 'daily', 'weekly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."architecture_status" AS ENUM('idle', 'running', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "architecture_refresh" "architecture_refresh" DEFAULT '6h' NOT NULL;

CREATE TABLE IF NOT EXISTS "app_architecture" (
	"app_id" integer PRIMARY KEY NOT NULL,
	"sha" text,
	"branch" text,
	"seen_sha" text,
	"repo_map" text,
	"summary" text,
	"status" "architecture_status" DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"checked_at" timestamp,
	"generated_at" timestamp,
	"started_at" timestamp,
	"force_requested" boolean DEFAULT false NOT NULL,
	"ai_model_id" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_usd" numeric(12, 6),
	CONSTRAINT "app_architecture_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "app_architecture_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "app_architecture_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"agent_id" integer,
	"sha" text NOT NULL,
	"summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ai_model_id" integer,
	"user_id" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_usd" numeric(12, 6),
	CONSTRAINT "app_architecture_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "app_architecture_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "app_architecture_runs_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "app_architecture_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "app_architecture_runs_app_created_idx" ON "app_architecture_runs" USING btree ("app_id", "created_at" DESC);
