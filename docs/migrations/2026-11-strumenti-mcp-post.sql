-- Migrazione di produzione: fine dei flag dei tool e della pausa per conferma (parte distruttiva).
-- Toglie le colonne che il codice non legge più: `app_tools.requires_confirmation` e `app_tools.read_only`
-- (sostituite da `level`), `runs.pending_action`, `runs.loop_state` e `runs.paused_at` (sostituite dalla coda
-- `pending_actions`; contenevano anche argomenti in chiaro delle vecchie azioni in sospeso).
-- DA APPLICARE DOPO il deploy di questo ramo (la versione precedente le usa ancora), sul DB Neon con:
--   psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-11-strumenti-mcp-post.sql
-- DISTRUTTIVA ma idempotente (`DROP COLUMN IF EXISTS`): una seconda esecuzione non cambia nulla.
-- Prima verificare che `2026-11-strumenti-mcp.sql` sia stata applicata (i livelli sono già stati travasati).

BEGIN;

ALTER TABLE "app_tools" DROP COLUMN IF EXISTS "requires_confirmation";
ALTER TABLE "app_tools" DROP COLUMN IF EXISTS "read_only";
ALTER TABLE "runs" DROP COLUMN IF EXISTS "pending_action";
ALTER TABLE "runs" DROP COLUMN IF EXISTS "loop_state";
ALTER TABLE "runs" DROP COLUMN IF EXISTS "paused_at";

COMMIT;
