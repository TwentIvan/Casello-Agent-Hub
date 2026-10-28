-- Migrazione di produzione: esecutore locale dell'architetto, tappa 1 (piano 2026-10-28-esecutore-locale-tappa-1).
-- Un'analisi può essere eseguita da un agente locale (Claude Code sul Mac dell'utente) tramite il server MCP:
-- l'esecutore, la lease con cui l'agente prende il compito, gli esiti consegnati per fase e i token personali
-- con cui l'agente si autentica.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-esecutore-locale.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione ignora le colonne e le tabelle nuove.

BEGIN;

-- Chi esegue l'analisi: il cloud (percorso storico) o l'agente locale
DO $$ BEGIN
  CREATE TYPE "public"."analysis_executor" AS ENUM('cloud', 'local');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Le analisi esistenti restano cloud; lease e commit sono valorizzati solo da quelle locali
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "executor" "analysis_executor" DEFAULT 'cloud' NOT NULL;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "lease_token_hash" text;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "lease_until" timestamp;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "lease_label" text;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "source_commit" text;

-- Esito consegnato dall'agente per ogni fase, validato con Zod prima di salvarlo
CREATE TABLE IF NOT EXISTS "analysis_phase_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"analysis_id" integer NOT NULL,
	"phase" text NOT NULL,
	"result" jsonb NOT NULL,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_phase_results_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "analysis_phase_results_unique" ON "analysis_phase_results" USING btree ("analysis_id", "phase");

-- Token personali (a riposo solo l'hash SHA-256)
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);

COMMIT;
