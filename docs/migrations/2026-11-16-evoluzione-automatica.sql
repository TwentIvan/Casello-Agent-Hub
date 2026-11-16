-- Ciclo di evoluzione automatica (Botcave, 3a): ciclo per App, giri, modalità delle analisi e traccia delle approvazioni automatiche.
-- Additiva e idempotente, niente `-post`: la applica il deploy.

DO $$ BEGIN
  CREATE TYPE "public"."evolution_cycle_status" AS ENUM('active', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."evolution_frequency" AS ENUM('daily', 'every_3_days', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."evolution_merge_mode" AS ENUM('staging', 'direct');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."evolution_round_status" AS ENUM('analyzing', 'approving', 'implementing', 'awaiting_release', 'done', 'blocked', 'rejected', 'stopped', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."analysis_mode" AS ENUM('full', 'evolution');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "mode" "analysis_mode" DEFAULT 'full' NOT NULL;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "evolution_round_id" integer;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "approved_by_cycle" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "evolution_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"status" "evolution_cycle_status" DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"frequency" "evolution_frequency" DEFAULT 'weekly' NOT NULL,
	"items_per_round" integer DEFAULT 3 NOT NULL,
	"analysis_ai_model_id" integer,
	"team_template_id" integer,
	"team_instance_id" integer,
	"merge_mode" "evolution_merge_mode" DEFAULT 'direct' NOT NULL,
	"staging_branch" text,
	"staging_url" text,
	"monthly_budget_usd" numeric(12, 2) NOT NULL,
	"activated_by" integer,
	"consent_at" timestamp,
	"consent_version" text,
	"consent_hash" text,
	"next_round_at" timestamp,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "evolution_cycles_app_id_unique" UNIQUE("app_id"),
	CONSTRAINT "evolution_cycles_items_per_round_check" CHECK ("items_per_round" BETWEEN 1 AND 10),
	CONSTRAINT "evolution_cycles_budget_check" CHECK ("monthly_budget_usd" > 0),
	CONSTRAINT "evolution_cycles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "evolution_cycles_analysis_ai_model_id_ai_models_id_fk" FOREIGN KEY ("analysis_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "evolution_cycles_team_template_id_team_templates_id_fk" FOREIGN KEY ("team_template_id") REFERENCES "public"."team_templates"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "evolution_cycles_team_instance_id_team_instances_id_fk" FOREIGN KEY ("team_instance_id") REFERENCES "public"."team_instances"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "evolution_cycles_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "evolution_rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"number" integer NOT NULL,
	"status" "evolution_round_status" NOT NULL,
	"analysis_id" integer,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"rejection_note" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "evolution_rounds_cycle_id_number_unique" UNIQUE("cycle_id", "number"),
	CONSTRAINT "evolution_rounds_cycle_id_evolution_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."evolution_cycles"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "evolution_rounds_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "evolution_rounds_one_open" ON "evolution_rounds" USING btree ("cycle_id") WHERE "status" in ('analyzing', 'approving', 'implementing', 'awaiting_release');

DO $$ BEGIN
  ALTER TABLE "analyses" ADD CONSTRAINT "analyses_evolution_round_id_evolution_rounds_id_fk" FOREIGN KEY ("evolution_round_id") REFERENCES "public"."evolution_rounds"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
