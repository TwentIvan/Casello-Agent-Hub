-- Alfred, il maggiordomo vocale: sessioni, conferme a voce e impostazioni dell'utente (additiva e idempotente).
-- Da applicare in produzione PRIMA del merge. Nessun `-post`.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alfred_session_status') THEN
    CREATE TYPE "public"."alfred_session_status" AS ENUM('active', 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alfred_decision') THEN
    CREATE TYPE "public"."alfred_decision" AS ENUM('approve', 'reject');
  END IF;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_ai_model_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alfred_voice" text;

CREATE TABLE IF NOT EXISTS "alfred_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ai_model_id" integer,
	"status" "alfred_session_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8),
	CONSTRAINT "alfred_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "alfred_sessions_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "alfred_sessions_user_status_idx" ON "alfred_sessions" USING btree ("user_id", "status");

CREATE TABLE IF NOT EXISTS "alfred_confirmations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"number" integer NOT NULL,
	"decision" "alfred_decision" NOT NULL,
	"note" text,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alfred_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "alfred_confirmations_session_id_alfred_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."alfred_sessions"("id") ON DELETE cascade ON UPDATE no action
);
CREATE INDEX IF NOT EXISTS "alfred_confirmations_session_used_idx" ON "alfred_confirmations" USING btree ("session_id", "used_at");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_alfred_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_alfred_ai_model_id_ai_models_id_fk" FOREIGN KEY ("alfred_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
