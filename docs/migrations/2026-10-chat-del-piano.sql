-- Migrazione di produzione: chat del piano (piano 2026-10-29-chat-del-piano).
-- L'utente discute con un bot il piano di un'app: conversazioni, messaggi e proposte (aggiungi, modifica,
-- scarta una voce) che si accettano o rifiutano una per una; le voci del piano ricordano origine e conversazione.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-chat-del-piano.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione ignora le colonne e le tabelle nuove.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "public"."plan_turn_status" AS ENUM('idle', 'running');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."plan_message_role" AS ENUM('user', 'assistant');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."plan_proposal_kind" AS ENUM('add', 'update', 'discard');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."plan_proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'stale');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."item_origin" AS ENUM('architect', 'chat');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "plan_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"analysis_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"ai_model_id" integer,
	"title" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"turn_status" "plan_turn_status" DEFAULT 'idle' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_conversations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_conversations_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "plan_conversations_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "plan_conversations_app_user_idx" ON "plan_conversations" USING btree ("app_id", "user_id");

CREATE TABLE IF NOT EXISTS "plan_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "plan_message_role" NOT NULL,
	"content" text NOT NULL,
	"error" boolean DEFAULT false NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_messages_conversation_id_plan_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."plan_conversations"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "plan_messages_conversation_idx" ON "plan_messages" USING btree ("conversation_id", "id");

-- Voci del piano: origine e conversazione che le ha create o modificate
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "origin" "item_origin" DEFAULT 'architect' NOT NULL;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "conversation_id" integer;
ALTER TABLE "analysis_items" DROP CONSTRAINT IF EXISTS "analysis_items_conversation_id_plan_conversations_id_fk";
ALTER TABLE "analysis_items" ADD CONSTRAINT "analysis_items_conversation_id_plan_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."plan_conversations"("id") ON DELETE set null ON UPDATE no action;

CREATE TABLE IF NOT EXISTS "plan_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"kind" "plan_proposal_kind" NOT NULL,
	"chapter" "analysis_chapter" NOT NULL,
	"payload" jsonb,
	"rationale" text NOT NULL,
	"target_item_id" integer,
	"target_hash" text,
	"status" "plan_proposal_status" DEFAULT 'pending' NOT NULL,
	"item_id" integer,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plan_proposals_conversation_id_plan_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."plan_conversations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_proposals_message_id_plan_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."plan_messages"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "plan_proposals_target_item_id_analysis_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."analysis_items"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "plan_proposals_item_id_analysis_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."analysis_items"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "plan_proposals_conversation_idx" ON "plan_proposals" USING btree ("conversation_id");

COMMIT;
