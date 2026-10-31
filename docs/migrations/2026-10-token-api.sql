-- Migrazione di produzione: ambiti dei token personali («token su /api»).
-- Ogni token ha un elenco di ambiti (`mcp`, `api:read`, `api:write`); i token esistenti diventano {mcp}, cioè
-- continuano a funzionare solo sul server MCP.
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-token-api.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore), PRIMA del merge. Idempotente: una seconda esecuzione
-- non cambia nulla. Solo aggiunte: la versione in produzione ignora la colonna nuova.

BEGIN;

ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT '{mcp}' NOT NULL;

COMMIT;
