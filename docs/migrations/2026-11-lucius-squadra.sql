-- Lucius sulla squadra e memorie dei personaggi: chat di squadra, appunti e storico (additiva e idempotente).
-- Da applicare in produzione PRIMA del merge. Nessun `-post`.

ALTER TABLE "plan_conversations" ADD COLUMN IF NOT EXISTS "summarized_at" timestamp;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_chat_proposal_kind') THEN
    CREATE TYPE "public"."team_chat_proposal_kind" AS ENUM('role_identity', 'role_instructions');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'character') THEN
    CREATE TYPE "public"."character" AS ENUM('alfred', 'lucius');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'character_history_kind') THEN
    CREATE TYPE "public"."character_history_kind" AS ENUM('alfred_session', 'plan_conversation', 'team_chat');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "team_chat_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_instance_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"ai_model_id" integer,
	"title" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"turn_status" "plan_turn_status" DEFAULT 'idle' NOT NULL,
	"summarized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_chat_conversations_team_instance_id_team_instances_id_fk" FOREIGN KEY ("team_instance_id") REFERENCES "public"."team_instances"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "team_chat_conversations_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_chat_conversations_team_user_idx" ON "team_chat_conversations" USING btree ("team_instance_id", "user_id");

CREATE TABLE IF NOT EXISTS "team_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "plan_message_role" NOT NULL,
	"content" text NOT NULL,
	"error" boolean DEFAULT false NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_chat_messages_conversation_id_team_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."team_chat_conversations"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_chat_messages_conversation_idx" ON "team_chat_messages" USING btree ("conversation_id", "id");

CREATE TABLE IF NOT EXISTS "team_chat_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"kind" "team_chat_proposal_kind" NOT NULL,
	"role_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"target_hash" text,
	"status" "plan_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_chat_proposals_conversation_id_team_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."team_chat_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "team_chat_proposals_message_id_team_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."team_chat_messages"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "team_chat_proposals_conversation_idx" ON "team_chat_proposals" USING btree ("conversation_id");

CREATE TABLE IF NOT EXISTS "character_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"content" text NOT NULL,
	"ref" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_notes_user_character_idx" ON "character_notes" USING btree ("user_id", "character");

CREATE TABLE IF NOT EXISTS "character_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"kind" "character_history_kind" NOT NULL,
	"ref_id" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"ai_model_id" integer,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "character_history_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "character_history_user_character_idx" ON "character_history" USING btree ("user_id", "character");
CREATE UNIQUE INDEX IF NOT EXISTS "character_history_ref_uniq" ON "character_history" USING btree ("user_id", "character", "kind", "ref_id");
