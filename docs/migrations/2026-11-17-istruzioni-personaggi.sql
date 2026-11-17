-- Istruzioni personali dei personaggi (Botcave): versioni delle istruzioni di Alfred e Lucius per utente e proposte di modifica
-- nate dalle chat. Additiva e idempotente, niente `-post`: la applica il deploy.

DO $$ BEGIN
  CREATE TYPE "public"."character_instruction_source" AS ENUM('manual', 'proposal', 'restore');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."instruction_conversation_kind" AS ENUM('character', 'plan_chat', 'team_chat');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."instruction_proposal_status" AS ENUM('pending', 'accepted', 'rejected', 'stale');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "character_instruction_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"conversation_kind" "instruction_conversation_kind" NOT NULL,
	"conversation_id" integer NOT NULL,
	"message_id" integer,
	"base_version" integer NOT NULL,
	"content" text NOT NULL,
	"reason" text NOT NULL,
	"status" "instruction_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "character_instructions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"character" "character" NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"source" "character_instruction_source" NOT NULL,
	"proposal_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "character_instructions_version_check" CHECK ("version" >= 1)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'character_instruction_proposals_user_id_users_id_fk') THEN
    ALTER TABLE "character_instruction_proposals" ADD CONSTRAINT "character_instruction_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'character_instructions_user_id_users_id_fk') THEN
    ALTER TABLE "character_instructions" ADD CONSTRAINT "character_instructions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'character_instructions_proposal_id_character_instruction_proposals_id_fk') THEN
    ALTER TABLE "character_instructions" ADD CONSTRAINT "character_instructions_proposal_id_character_instruction_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."character_instruction_proposals"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "character_instructions_user_char_version_uniq" ON "character_instructions" USING btree ("user_id", "character", "version");
CREATE INDEX IF NOT EXISTS "character_instruction_proposals_conv_idx" ON "character_instruction_proposals" USING btree ("conversation_kind", "conversation_id");
