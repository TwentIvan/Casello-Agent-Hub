-- Migrazione di produzione: token in cache (spec 2026-10-28-casello-architetto-lettura-efficiente-design.md §5 e §7).
-- I token di prompt letti dalla cache del provider si salvano a parte (analisi e run) e si pagano al prezzo di
-- cache del modello (ai_models), che arriva dal catalogo passando dalle offerte (model_offers).
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-lettura-efficiente.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Nessuna parte distruttiva: la versione in produzione ignora le colonne nuove.

BEGIN;

-- Le analisi e le run esistenti partono da 0 token in cache
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "cached_tokens" integer DEFAULT 0 NOT NULL;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "cached_tokens" integer DEFAULT 0 NOT NULL;

-- Prezzo dei token in cache (USD per milione); null = non noto, si usa il prezzo pieno di input
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "price_cached_input_per_mtok" numeric(12, 6);
ALTER TABLE "model_offers" ADD COLUMN IF NOT EXISTS "price_cached_input_per_mtok" numeric(12, 6);

COMMIT;
