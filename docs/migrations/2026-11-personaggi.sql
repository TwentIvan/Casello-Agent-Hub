-- Alfred e Lucius nelle aree: conversazioni, messaggi e proposte dei personaggi, modelli e tetti per personaggio
-- (additiva e idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

-- Fuori da transazioni esplicite: il valore nuovo non si usa in questo script
ALTER TYPE "public"."character_history_kind" ADD VALUE IF NOT EXISTS 'character_chat';

-- Colonne di users: modelli e tetti per personaggio
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_chat_ai_model_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lucius_ai_model_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_monthly_budget_usd" numeric(12, 2);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lucius_monthly_budget_usd" numeric(12, 2);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_alfred_chat_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_alfred_chat_ai_model_id_ai_models_id_fk" FOREIGN KEY ("alfred_chat_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_lucius_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_lucius_ai_model_id_ai_models_id_fk" FOREIGN KEY ("lucius_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "character_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"subject_title" text,
	"ai_model_id" integer,
	"title" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"turn_status" "plan_turn_status" DEFAULT 'idle' NOT NULL,
	"archived_at" timestamp,
	"summarized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_conversations_subject_type_check" CHECK ("subject_type" IN ('alfred_thread', 'agent', 'skill', 'team_template', 'area_agents', 'area_skills', 'area_team_templates')),
	CONSTRAINT "character_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "character_conversations_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_conversations_subject_idx" ON "character_conversations" USING btree ("user_id", "character", "subject_type", "subject_id");
CREATE UNIQUE INDEX IF NOT EXISTS "character_conversations_alfred_open_uniq" ON "character_conversations" USING btree ("user_id") WHERE "subject_type" = 'alfred_thread' AND "archived_at" IS NULL;

CREATE TABLE IF NOT EXISTS "character_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "plan_message_role" NOT NULL,
	"content" text NOT NULL,
	"error" boolean DEFAULT false NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"page_context" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_messages_conversation_id_character_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."character_conversations"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_messages_conversation_idx" ON "character_messages" USING btree ("conversation_id", "id");

CREATE TABLE IF NOT EXISTS "character_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"target_hash" text,
	"status" "plan_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_proposals_kind_check" CHECK ("kind" IN ('agent_prompt', 'agent_tools', 'skill_content', 'template_roles', 'agent_create', 'skill_create', 'template_create', 'decision', 'handoff')),
	CONSTRAINT "character_proposals_conversation_id_character_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."character_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "character_proposals_message_id_character_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."character_messages"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_proposals_conversation_idx" ON "character_proposals" USING btree ("conversation_id");
