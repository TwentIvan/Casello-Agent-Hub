-- Tool ui eseguiti dal client (issue #96): una run avviata con `clientTools` offre al modello i tool `ui` dell'app; la
-- chiamata va in `client_action` e la run passa a `awaiting_client` finché il client non manda l'esito (additiva,
-- idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "client_tools" boolean DEFAULT false NOT NULL;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "client_action" jsonb;
