-- Header fissi per app: header HTTP non segreti (es. X-Organization-Id) che l'esecutore manda su ogni chiamata ai
-- tool dell'app, HTTP e MCP (additiva, idempotente). Da applicare in produzione PRIMA del merge. Nessun `-post`.

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "extra_headers" jsonb DEFAULT '[]'::jsonb NOT NULL;
