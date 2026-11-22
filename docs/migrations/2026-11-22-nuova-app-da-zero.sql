-- Nuova app da zero (Botcave, tappa 1): voce `app_bootstrap` in «Da confermare» e tabella `app_bootstraps` (nascita di un'App da un repository modello).
-- Additiva e idempotente, niente `-post`: la applica il deploy. `ALTER TYPE … ADD VALUE` fuori da una transazione esplicita.

ALTER TYPE "public"."pending_action_kind" ADD VALUE IF NOT EXISTS 'app_bootstrap';

DO $$ BEGIN
  CREATE TYPE "public"."app_bootstrap_status" AS ENUM('pending', 'running', 'done', 'failed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "app_bootstraps" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(80) NOT NULL,
	"domain" varchar(253) NOT NULL,
	"repo" text NOT NULL,
	"installation_id" integer NOT NULL,
	"brief" text NOT NULL,
	"ai_model_id" integer,
	"status" "app_bootstrap_status" DEFAULT 'pending' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"init_commit_sha" text,
	"app_id" integer,
	"analysis_id" integer,
	"pending_action_id" integer,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_ok_at" timestamp,
	"health_checked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_bootstraps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "app_bootstraps_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "app_bootstraps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "app_bootstraps_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "app_bootstraps_pending_action_id_pending_actions_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "public"."pending_actions"("id") ON DELETE set null ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "app_bootstraps_slug_open_uidx" ON "app_bootstraps" USING btree ("slug") WHERE "app_bootstraps"."status" in ('pending', 'running', 'done');
CREATE UNIQUE INDEX IF NOT EXISTS "app_bootstraps_repo_open_uidx" ON "app_bootstraps" USING btree ("repo") WHERE "app_bootstraps"."status" in ('pending', 'running', 'done');
CREATE INDEX IF NOT EXISTS "app_bootstraps_app_id_idx" ON "app_bootstraps" USING btree ("app_id");
