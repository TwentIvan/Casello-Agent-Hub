-- Migrazione di produzione: fine della «pulizia del gateway» (parte distruttiva).
-- Elimina gli ultimi resti del gateway LiteLLM: modelli e account di sistema, provider `system_gateway`
-- e il vecchio enum `ai_provider` (esiste solo nel DB di produzione).
-- DA APPLICARE DOPO il deploy di questo ramo (la versione precedente usa ancora quelle righe), sul DB Neon con:
--   psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-10-pulizia-gateway-post.sql
-- (senza ON_ERROR_STOP psql proseguirebbe dopo un errore). DISTRUTTIVA ma idempotente: una seconda esecuzione
-- non cambia nulla. Tutto in una transazione: se un agente usa ancora un modello del gateway lo script si
-- ferma con un errore e non modifica nulla (sposta prima quegli agenti su un account personale).
-- Analisi, run e conversazioni del piano restano: `ai_model_id` torna null (ON DELETE SET NULL), costo e
-- nome del modello restano.

BEGIN;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM agents a
    JOIN ai_models m ON m.id = a.ai_model_id
    JOIN ai_accounts acc ON acc.id = m.account_id
   WHERE acc.provider = 'system_gateway' AND acc.user_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'agenti ancora su modelli del gateway (%): spostali prima su un account personale', n;
  END IF;
END $$;

DELETE FROM "ai_models"
 WHERE "account_id" IN (SELECT "id" FROM "ai_accounts" WHERE "provider" = 'system_gateway' AND "user_id" IS NULL);
DELETE FROM "ai_accounts" WHERE "provider" = 'system_gateway' AND "user_id" IS NULL;
DELETE FROM "model_offers" WHERE "provider" = 'system_gateway';
DELETE FROM "providers" WHERE "slug" = 'system_gateway';

DROP TYPE IF EXISTS "public"."ai_provider";

COMMIT;
