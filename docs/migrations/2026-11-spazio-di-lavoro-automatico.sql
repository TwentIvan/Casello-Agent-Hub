-- Spazio di lavoro automatico dei ruoli node con codice: stato di Git sul Mac comunicato dal nodo con l'heartbeat
-- (additiva, idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "git_status" jsonb;
