-- Inneschi: sorveglianza di un tool e webhook che avviano le run di un agente (additiva, idempotente).
-- Da applicare in produzione PRIMA del merge. Nessun `-post`.

DO $$ BEGIN
  CREATE TYPE "public"."trigger_kind" AS ENUM('poll', 'webhook');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."trigger_status" AS ENUM('active', 'paused', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "agent_triggers" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer NOT NULL,
	"kind" "trigger_kind" NOT NULL,
	"name" text NOT NULL,
	"status" "trigger_status" DEFAULT 'paused' NOT NULL,
	"instructions" text,
	"created_by" integer,
	"tool_id" integer,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"items_path" text,
	"id_field" text,
	"version_field" text,
	"cursor_param" text,
	"cursor_field" text,
	"cursor_value" text,
	"filter" jsonb,
	"interval_seconds" integer DEFAULT 300,
	"next_poll_at" timestamp with time zone,
	"baseline_done" boolean DEFAULT false NOT NULL,
	"dedup_header" text,
	"secret_hash" text,
	"signing_secret_enc" text,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"runs_created" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_triggers_agent_name_key" UNIQUE ("agent_id", "name"),
	CONSTRAINT "agent_triggers_poll_check" CHECK ("kind" <> 'poll' OR ("tool_id" IS NOT NULL AND "interval_seconds" IS NOT NULL AND "next_poll_at" IS NOT NULL)),
	CONSTRAINT "agent_triggers_webhook_check" CHECK ("kind" <> 'webhook' OR "secret_hash" IS NOT NULL),
	CONSTRAINT "agent_triggers_cursor_check" CHECK ("cursor_param" IS NULL OR "cursor_field" IS NOT NULL),
	CONSTRAINT "agent_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_triggers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "agent_triggers_tool_id_app_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."app_tools"("id") ON DELETE restrict ON UPDATE no action
);

CREATE TABLE IF NOT EXISTS "trigger_seen_items" (
	"trigger_id" integer NOT NULL,
	"item_key" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_seen_items_trigger_id_item_key_pk" PRIMARY KEY ("trigger_id", "item_key"),
	CONSTRAINT "trigger_seen_items_trigger_id_agent_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."agent_triggers"("id") ON DELETE cascade ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "agent_triggers_due_idx" ON "agent_triggers" USING btree ("status", "next_poll_at");
CREATE INDEX IF NOT EXISTS "agent_triggers_agent_idx" ON "agent_triggers" USING btree ("agent_id");
CREATE INDEX IF NOT EXISTS "trigger_seen_items_seen_at_idx" ON "trigger_seen_items" USING btree ("seen_at");

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "trigger_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runs_trigger_id_agent_triggers_id_fk') THEN
    ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_id_agent_triggers_id_fk"
      FOREIGN KEY ("trigger_id") REFERENCES "public"."agent_triggers"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "runs_trigger_id_idx" ON "runs" USING btree ("trigger_id");

-- Nuovo tipo di scheda dei personaggi: creazione di un innesco
ALTER TABLE "character_proposals" DROP CONSTRAINT IF EXISTS "character_proposals_kind_check";
ALTER TABLE "character_proposals" ADD CONSTRAINT "character_proposals_kind_check"
  CHECK ("kind" IN ('agent_prompt', 'agent_tools', 'skill_content', 'template_roles', 'agent_create', 'skill_create', 'template_create', 'decision', 'handoff', 'agent_trigger_create'));
