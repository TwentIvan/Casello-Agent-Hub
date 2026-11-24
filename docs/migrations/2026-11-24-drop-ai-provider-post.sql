-- Migrazione di produzione (parte distruttiva, issue #92): elimina il vecchio enum `ai_provider`.
-- Dopo il passaggio ai provider come dati (`2026-10-catalogo-universale.sql`) nessuna colonna lo usa più e il codice non lo
-- legge. Lo elimina anche `2026-10-pulizia-gateway-post.sql`, insieme ai resti del gateway: questo file lo fa da solo, così
-- l'enum si toglie anche se la pulizia del gateway non si può ancora applicare (es. agenti ancora su modelli del gateway).
-- NON la applica il deploy (file `-post`): da eseguire a mano sul DB Neon con
--   psql -v ON_ERROR_STOP=1 -f docs/migrations/2026-11-24-drop-ai-provider-post.sql
-- Idempotente: senza l'enum non fa nulla. Se una colonna, un attributo di un tipo composto, un dominio o un array usa ancora
-- l'enum lo script si ferma con un errore e non modifica nulla (niente CASCADE).

BEGIN;

DO $$
DECLARE
  t oid;
  n integer;
BEGIN
  SELECT oid INTO t FROM pg_type WHERE typname = 'ai_provider' AND typnamespace = 'public'::regnamespace;
  IF t IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO n
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
   WHERE NOT a.attisdropped
     AND a.attnum > 0
     AND (a.atttypid = t OR a.atttypid IN (SELECT oid FROM pg_type WHERE typelem = t OR typbasetype = t));
  IF n > 0 THEN
    RAISE EXCEPTION 'l''enum ai_provider è ancora usato da % colonne: convertile prima in testo', n;
  END IF;
END $$;

DROP TYPE IF EXISTS "public"."ai_provider";

COMMIT;
