-- Lavoro su branch unico delle squadre con codice (Botcave, 3b): versione di prova dell'App, lavori delle squadre, voce «Porta in produzione».
-- Additiva e idempotente, niente `-post`: la applica il deploy. `ALTER TYPE … ADD VALUE` fuori da una transazione esplicita.

ALTER TYPE "public"."pending_action_kind" ADD VALUE IF NOT EXISTS 'release';
ALTER TYPE "public"."team_event_type" ADD VALUE IF NOT EXISTS 'lavoro_in_prova';

DO $$ BEGIN
  CREATE TYPE "public"."team_work_status" AS ENUM('open', 'awaiting_release', 'releasing', 'released', 'abandoned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "staging_branch" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "staging_url" text;

CREATE TABLE IF NOT EXISTS "team_works" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"number" integer NOT NULL,
	"status" "team_work_status" DEFAULT 'open' NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text,
	"post_scripts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_action_id" integer,
	"release_pr_number" integer,
	"release_pr_url" text,
	"release_ci_since" timestamp,
	"rejection_note" text,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_works_instance_number_unique" UNIQUE("instance_id", "number"),
	CONSTRAINT "team_works_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_works_pending_action_id_pending_actions_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "public"."pending_actions"("id") ON DELETE set null ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_works_one_open" ON "team_works" USING btree ("instance_id") WHERE "team_works"."status" in ('open', 'awaiting_release', 'releasing');

ALTER TABLE "team_code_tasks" ADD COLUMN IF NOT EXISTS "work_id" integer;

DO $$ BEGIN
  ALTER TABLE "team_code_tasks" ADD CONSTRAINT "team_code_tasks_work_id_team_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."team_works"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
