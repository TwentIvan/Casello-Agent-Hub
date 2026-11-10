-- Strumenti GitHub per i ruoli cloud delle squadre: stato del codice scritto per compito (additiva, idempotente).
-- Da applicare in produzione PRIMA del merge. Nessun `-post`.

DO $$ BEGIN
  CREATE TYPE "public"."code_pr_state" AS ENUM('open', 'merged', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."code_ci_state" AS ENUM('pending', 'success', 'failure', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "team_code_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"plan_task_id" text NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"head_sha" text,
	"pr_number" integer,
	"pr_url" text,
	"pr_state" "code_pr_state",
	"ci_state" "code_ci_state",
	"ci_summary" text,
	"ci_checked_at" timestamp,
	"ci_notified_sha" text,
	"ci_pending_notified" boolean DEFAULT false NOT NULL,
	"ci_failures" integer DEFAULT 0 NOT NULL,
	"last_commit_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_code_tasks_instance_plan_task_unique" UNIQUE("instance_id","plan_task_id"),
	CONSTRAINT "team_code_tasks_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action
);
-- Colonna aggiunta dopo la prima versione dello script: idempotente anche su una tabella già creata
ALTER TABLE "team_code_tasks" ADD COLUMN IF NOT EXISTS "ci_failures" integer DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "team_code_tasks_watch_idx" ON "team_code_tasks" USING btree ("pr_state", "ci_checked_at");
