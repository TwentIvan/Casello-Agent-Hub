-- Esecutore Claude Code sul nodo: account AI legato a un nodo, modello di ripiego, coda dei turni delegati al nodo (additiva e idempotente).
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- La riga del provider `claude_code_node` la scrive `ensureProviderRegistry` all'avvio dell'API.
-- Da applicare su Neon PRIMA del merge. Nessun `-post`.

ALTER TYPE "public"."provider_protocol" ADD VALUE IF NOT EXISTS 'claude_code_node';

ALTER TABLE "ai_accounts" ADD COLUMN IF NOT EXISTS "node_id" integer;
ALTER TABLE "ai_accounts" ADD COLUMN IF NOT EXISTS "fallback_ai_model_id" integer;

DO $$ BEGIN
  ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_fallback_ai_model_id_ai_models_id_fk" FOREIGN KEY ("fallback_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Un account per nodo
CREATE UNIQUE INDEX IF NOT EXISTS "ai_accounts_one_per_node" ON "ai_accounts" USING btree ("node_id") WHERE "ai_accounts"."node_id" IS NOT NULL;

ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "last_turn_poll_at" timestamp;

DO $$ BEGIN
  CREATE TYPE "public"."node_turn_consumer" AS ENUM('character', 'plan_chat', 'team_chat', 'run');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."node_turn_status" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "node_turns" (
	"id" serial PRIMARY KEY NOT NULL,
	"node_id" integer,
	"user_id" integer NOT NULL,
	"ai_model_id" integer,
	"consumer" "node_turn_consumer" NOT NULL,
	"ref_id" integer NOT NULL,
	"message_id" integer,
	"status" "node_turn_status" DEFAULT 'queued' NOT NULL,
	"package" jsonb,
	"turn_token_hash" text NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"content" text,
	"error_code" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer,
	"cost_usd" numeric(12, 6),
	"session_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"claimed_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "node_turns_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "node_turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "node_turns_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "node_turns_node_status_idx" ON "node_turns" USING btree ("node_id", "status", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "node_turns_token_hash_unique" ON "node_turns" USING btree ("turn_token_hash");

-- Nota informativa dei passi delle run (esecutore del turno, ripiego)
ALTER TABLE "run_steps" ADD COLUMN IF NOT EXISTS "note" text;
