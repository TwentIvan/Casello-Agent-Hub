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
	CONSTRAINT "team_tasks_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_tasks_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
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
