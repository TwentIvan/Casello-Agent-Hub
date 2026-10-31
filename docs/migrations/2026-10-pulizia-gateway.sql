-- Migrazione di produzione: modello predefinito dell'utente («pulizia del gateway», parte additiva).
-- Gli agenti che Casello crea (agente generale di un'app nuova, agenti approvati dall'architetto, agenti creati
-- senza modello) usano il modello scelto, poi il predefinito dell'utente, poi nessuno.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-pulizia-gateway.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione ignora la colonna nuova.

BEGIN;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_ai_model_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_default_ai_model_id_ai_models_id_fk') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_default_ai_model_id_ai_models_id_fk"
      FOREIGN KEY ("default_ai_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

COMMIT;
