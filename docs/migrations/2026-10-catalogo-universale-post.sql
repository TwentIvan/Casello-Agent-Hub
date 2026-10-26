-- Migrazione di produzione: catalogo universale, eliminazione del vecchio catalogo (spec
-- 2026-10-26-casello-catalogo-universale-design.md §10). DA APPLICARE DOPO IL DEPLOY, quando l'API nuova è attiva:
-- la versione precedente legge ancora ai_models.catalog_id e model_catalog, e prima del deploy si romperebbe.
-- Prima va applicato 2026-10-catalogo-universale.sql (prima del merge).
-- Eseguire sul DB Neon con: psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-catalogo-universale-post.sql
-- Idempotente: una seconda esecuzione non cambia nulla.

BEGIN;

ALTER TABLE "ai_models" DROP CONSTRAINT IF EXISTS "ai_models_catalog_id_model_catalog_id_fk";
ALTER TABLE "ai_models" DROP COLUMN IF EXISTS "catalog_id";
DROP TABLE IF EXISTS "model_catalog";

COMMIT;
