-- Migrazione di produzione: tetti di spesa mensili per utente e per agente (blocco 2 dell'evoluzione).
-- Il tetto (USD al mese, null = nessun limite) blocca i nuovi avvii quando la spesa del mese lo raggiunge; ogni run
-- ricorda il modello con cui è partita, così la spesa resta di chi paga anche se l'agente cambia modello.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-tetti-di-spesa.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione ignora le colonne nuove.

BEGIN;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthly_budget_usd" numeric(12, 2);
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "monthly_budget_usd" numeric(12, 2);

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "ai_model_id" integer;
DO $$ BEGIN
  ALTER TABLE "runs" ADD CONSTRAINT "runs_ai_model_id_ai_models_id_fk" FOREIGN KEY ("ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Le run esistenti prendono il modello attuale del loro agente (l'unico dato disponibile)
UPDATE "runs" SET "ai_model_id" = "agents"."ai_model_id"
  FROM "agents"
  WHERE "runs"."agent_id" = "agents"."id" AND "runs"."ai_model_id" IS NULL AND "agents"."ai_model_id" IS NOT NULL;

-- Somme del mese: per modello (spesa dell'utente) e per agente
CREATE INDEX IF NOT EXISTS "runs_ai_model_created_idx" ON "runs" USING btree ("ai_model_id", "created_at");
CREATE INDEX IF NOT EXISTS "runs_agent_created_idx" ON "runs" USING btree ("agent_id", "created_at");

COMMIT;
