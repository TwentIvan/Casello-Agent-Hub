-- Migrazione di produzione: collegamento delle voci del piano alle issue GitHub («dal piano alle issue»).
-- Ogni voce può avere una issue creata da Casello: repository, numero, indirizzo, stato (`creating` durante la
-- prenotazione, poi `open` / `closed`), motivo di chiusura e data dell'ultimo controllo.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-piano-issue.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione ignora le colonne nuove.

BEGIN;

ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "issue_repo" text;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "issue_number" integer;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "issue_url" text;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "issue_state" text;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "issue_state_reason" text;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "issue_created_at" timestamp;
ALTER TABLE "analysis_items" ADD COLUMN IF NOT EXISTS "issue_checked_at" timestamp;

CREATE INDEX IF NOT EXISTS "analysis_items_issue_idx" ON "analysis_items" USING btree ("issue_repo", "issue_number") WHERE "issue_number" IS NOT NULL;

COMMIT;
