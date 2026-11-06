-- Botcave come plugin di The Hub Up: client OAuth di prima parte e modello dell'indirizzo del plugin.
-- Additiva e idempotente: da applicare in produzione PRIMA del merge.
ALTER TYPE oauth_client_kind ADD VALUE IF NOT EXISTS 'plugin';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS plugin_url_template text;
