-- Migrazione di produzione: tetti di spesa mensili per modello AI e per account AI (una chiave presso un provider).
-- Il tetto (USD al mese, null = nessun limite) blocca i nuovi avvii che spenderebbero su quel modello o account quando
-- la spesa del mese lo raggiunge, come i tetti per utente e per agente.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-tetti-modello-provider.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione ignora le colonne nuove.

BEGIN;

ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "monthly_budget_usd" numeric(12, 2);
ALTER TABLE "ai_accounts" ADD COLUMN IF NOT EXISTS "monthly_budget_usd" numeric(12, 2);

COMMIT;
