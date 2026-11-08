-- Proposte multiple di Botcave (5c, tappa 4): voce `proposal` della coda «Da confermare» con più passi, tabella dei passi
-- e passi esclusi nelle conferme a voce di Alfred (additiva e idempotente).
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- Da applicare su Neon PRIMA del merge. Nessun `-post`.

ALTER TYPE "public"."pending_action_kind" ADD VALUE IF NOT EXISTS 'proposal';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pending_action_step_status') THEN
    CREATE TYPE "public"."pending_action_step_status" AS ENUM('pending', 'excluded', 'skipped', 'done', 'failed', 'not_run');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "pending_action_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"pending_action_id" integer NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"tool_id" integer NOT NULL,
	"summary" text NOT NULL,
	"status" "pending_action_step_status" DEFAULT 'pending' NOT NULL,
	"result" text,
	"error_message" text,
	"finished_at" timestamp
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_action_steps_pending_action_id_pending_actions_id_fk') THEN
    ALTER TABLE "pending_action_steps" ADD CONSTRAINT "pending_action_steps_pending_action_id_pending_actions_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "public"."pending_actions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_action_steps_tool_id_app_tools_id_fk') THEN
    ALTER TABLE "pending_action_steps" ADD CONSTRAINT "pending_action_steps_tool_id_app_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."app_tools"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_action_steps_action_key_unique') THEN
    ALTER TABLE "pending_action_steps" ADD CONSTRAINT "pending_action_steps_action_key_unique" UNIQUE ("pending_action_id", "key");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "pending_action_steps_tool_id_idx" ON "pending_action_steps" USING btree ("tool_id");

ALTER TABLE "alfred_confirmations" ADD COLUMN IF NOT EXISTS "exclude_steps" jsonb;
