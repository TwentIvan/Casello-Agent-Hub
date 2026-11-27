-- Collaudo dei lavori prima di «Porta in produzione» (Botcave): tabelle dei collaudi, dei loro passi, comandi e file, ricette di collaudo delle App.
-- Additiva e idempotente, niente `-post`: la applica il deploy.

DO $$ BEGIN
  CREATE TYPE "public"."release_test_status" AS ENUM('queued', 'dispatching', 'running', 'done', 'failed', 'skipped', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."release_test_outcome" AS ENUM('ok', 'problems', 'not_startable');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."release_test_mode" AS ENUM('full', 'relight');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."release_test_command_status" AS ENUM('pending', 'sent', 'done', 'failed', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."release_test_file_kind" AS ENUM('video', 'screenshot');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."app_test_recipe_source" AS ENUM('agent', 'user');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "test_recipe" jsonb;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "test_recipe_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "test_auto_fix" boolean DEFAULT false NOT NULL;
ALTER TABLE "team_works" ADD COLUMN IF NOT EXISTS "test_auto_rejects" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "release_tests" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"work_id" integer NOT NULL,
	"instance_id" integer NOT NULL,
	"sha" text NOT NULL,
	"mode" "release_test_mode" DEFAULT 'full' NOT NULL,
	"status" "release_test_status" DEFAULT 'queued' NOT NULL,
	"outcome" "release_test_outcome",
	"report" text,
	"problems" jsonb,
	"not_testable" jsonb,
	"error" text,
	"code_hash" text,
	"code_expires_at" timestamp,
	"token_hash" text,
	"token_expires_at" timestamp,
	"lease_expires_at" timestamp,
	"github_run_id" text,
	"tunnel_url" text,
	"tunnel_until" timestamp,
	"ai_model_id" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "release_tests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "release_tests_work_id_team_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."team_works"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "release_tests_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "release_tests_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);

-- Un solo collaudo lanciato o in corso per App: è in docs/migrations/2026-11-27-collaudo-coda-per-app.sql
CREATE INDEX IF NOT EXISTS "release_tests_status_created_idx" ON "release_tests" USING btree ("status", "created_at");
CREATE INDEX IF NOT EXISTS "release_tests_work_idx" ON "release_tests" USING btree ("work_id");

CREATE TABLE IF NOT EXISTS "release_test_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"test_id" integer NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"tool_name" text,
	"args" jsonb,
	"ok" boolean,
	"http_status" integer,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "release_test_steps_test_id_release_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."release_tests"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "release_test_steps_test_id_position_idx" ON "release_test_steps" USING btree ("test_id", "position");

CREATE TABLE IF NOT EXISTS "release_test_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"test_id" integer NOT NULL,
	"kind" text NOT NULL,
	"args" jsonb,
	"status" "release_test_command_status" DEFAULT 'pending' NOT NULL,
	"output" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "release_test_commands_test_id_release_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."release_tests"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "release_test_commands_test_status_idx" ON "release_test_commands" USING btree ("test_id", "status");

CREATE TABLE IF NOT EXISTS "release_test_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"test_id" integer NOT NULL,
	"kind" "release_test_file_kind" NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" bytea NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "release_test_files_test_id_release_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."release_tests"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "release_test_files_test_idx" ON "release_test_files" USING btree ("test_id");
CREATE INDEX IF NOT EXISTS "release_test_files_created_idx" ON "release_test_files" USING btree ("created_at");

CREATE TABLE IF NOT EXISTS "app_test_recipes" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"version" integer NOT NULL,
	"recipe" jsonb NOT NULL,
	"source" "app_test_recipe_source" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_test_recipes_app_version_unique" UNIQUE("app_id", "version"),
	CONSTRAINT "app_test_recipes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action
);
