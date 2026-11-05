-- Nodo locale: cartelle della radice degli spazi di lavoro comunicate dal nodo con l'heartbeat, per la scelta dello
-- spazio di lavoro in console (additiva, idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "workspace_folders" jsonb;
ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "folders_updated_at" timestamp;
