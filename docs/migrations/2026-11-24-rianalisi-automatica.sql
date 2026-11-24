-- Rianalisi incrementale dopo ogni merge (issue #113): con `apps.auto_reanalysis` Botcave controlla lo SHA del branch base
-- e, quando cambia, mette in coda un'analisi con l'agente locale; `analyses.trigger_commit` è lo SHA che l'ha avviata
-- (null = avviata a mano). Additiva e idempotente, niente `-post`: la applica il deploy.

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "auto_reanalysis" boolean DEFAULT false NOT NULL;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "reanalysis_seen_sha" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "reanalysis_checked_at" timestamp;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "trigger_commit" text;
