-- Segnalazione dei bug dal plugin (Botcave): impostazioni sull'App, squadra designata per i bug, segnalazioni e relativi messaggi,
-- voce `bug` della coda «Da confermare». Additiva e idempotente, niente `-post`: la applica il deploy.
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- Il valore `bug` non si usa in questo file.

ALTER TYPE "public"."pending_action_kind" ADD VALUE IF NOT EXISTS 'bug';

DO $$ BEGIN
  CREATE TYPE "public"."bug_report_status" AS ENUM('received', 'triage', 'needs_info', 'pending_approval', 'in_progress', 'fixed', 'not_a_bug', 'duplicate', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."bug_reporter_kind" AS ENUM('identity', 'browser');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."bug_message_author" AS ENUM('reporter', 'lead', 'owner');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "bug_reports_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "bug_reports_daily_limit" integer DEFAULT 20 NOT NULL;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "identity_secret_enc" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "identity_secret_set_at" timestamp;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apps_bug_reports_daily_limit_check') THEN
    ALTER TABLE "apps" ADD CONSTRAINT "apps_bug_reports_daily_limit_check" CHECK ("bug_reports_daily_limit" BETWEEN 1 AND 500);
  END IF;
END $$;

ALTER TABLE "team_instances" ADD COLUMN IF NOT EXISTS "bug_team" boolean DEFAULT false NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "team_instances_bug_team_uidx" ON "team_instances" USING btree ("ref_app_id") WHERE "bug_team" AND "status" <> 'closed';

CREATE TABLE IF NOT EXISTS "bug_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"number" integer NOT NULL,
	"reporter_kind" "bug_reporter_kind" NOT NULL,
	"reporter_sub" text,
	"reporter_name" text,
	"reporter_email" text,
	"browser_key_hash" text,
	"ip_prefix" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"steps" text,
	"expected" text,
	"page_context" jsonb,
	"status" "bug_report_status" DEFAULT 'received' NOT NULL,
	"public_message" text,
	"triage" jsonb,
	"triage_run_id" integer,
	"pending_action_id" integer,
	"team_instance_id" integer,
	"issue_number" integer,
	"issue_url" text,
	"pr_url" text,
	"reporter_seen_at" timestamp,
	"status_changed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bug_reports_app_number_uniq" UNIQUE("app_id", "number")
);

CREATE TABLE IF NOT EXISTS "bug_report_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"author" "bug_message_author" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_app_id_apps_id_fk') THEN
    ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_triage_run_id_runs_id_fk') THEN
    ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_triage_run_id_runs_id_fk" FOREIGN KEY ("triage_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_pending_action_id_pending_actions_id_fk') THEN
    ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_pending_action_id_pending_actions_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "public"."pending_actions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_reports_team_instance_id_team_instances_id_fk') THEN
    ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_team_instance_id_team_instances_id_fk" FOREIGN KEY ("team_instance_id") REFERENCES "public"."team_instances"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bug_report_messages_report_id_bug_reports_id_fk') THEN
    ALTER TABLE "bug_report_messages" ADD CONSTRAINT "bug_report_messages_report_id_bug_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "bug_reports_app_status_idx" ON "bug_reports" USING btree ("app_id", "status");
CREATE INDEX IF NOT EXISTS "bug_reports_app_sub_idx" ON "bug_reports" USING btree ("app_id", "reporter_sub");
CREATE INDEX IF NOT EXISTS "bug_reports_app_key_idx" ON "bug_reports" USING btree ("app_id", "browser_key_hash");
CREATE INDEX IF NOT EXISTS "bug_reports_triage_run_idx" ON "bug_reports" USING btree ("triage_run_id");
CREATE INDEX IF NOT EXISTS "bug_report_messages_report_idx" ON "bug_report_messages" USING btree ("report_id", "created_at");
