-- Relazioni tra i ruoli di una squadra (Botcave): frecce «chi può contattare chi» nei modelli e nelle squadre,
-- consultazioni e messaggi tra ruoli durante i compiti. Additiva e idempotente, niente `-post`: la applica il deploy.

ALTER TABLE "team_template_versions" ADD COLUMN IF NOT EXISTS "links" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "team_instances" ADD COLUMN IF NOT EXISTS "links" jsonb DEFAULT '[]'::jsonb NOT NULL;

DO $$ BEGIN
  CREATE TYPE "public"."team_role_message_kind" AS ENUM('consult', 'note');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."team_role_message_status" AS ENUM('pending', 'answered', 'failed', 'delivered');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "team_role_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"from_task_id" integer,
	"from_role" text NOT NULL,
	"to_role" text NOT NULL,
	"kind" "team_role_message_kind" NOT NULL,
	"status" "team_role_message_status" DEFAULT 'pending' NOT NULL,
	"text" text NOT NULL,
	"answer" text,
	"error" text,
	"delivered_task_id" integer,
	"ai_model_id" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "team_role_messages_instance_id_team_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_role_messages_from_task_id_team_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."team_tasks"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "team_role_messages_delivered_task_id_team_tasks_id_fk" FOREIGN KEY ("delivered_task_id") REFERENCES "public"."team_tasks"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "team_role_messages_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "team_role_messages_instance_idx" ON "team_role_messages" USING btree ("instance_id", "created_at");
CREATE INDEX IF NOT EXISTS "team_role_messages_pending_notes_idx" ON "team_role_messages" USING btree ("instance_id", "to_role") WHERE "kind" = 'note' AND "status" = 'pending';
