-- Collaudo dei lavori (Botcave): più collaudi in coda per App, uno solo lanciato o in corso; segno di vita dell'agente collaudatore.
-- Additiva e idempotente, niente `-post`: la applica il deploy.

-- Un solo collaudo lanciato o in corso per App: quelli di altri lavori aspettano in coda
CREATE UNIQUE INDEX IF NOT EXISTS "release_tests_one_active_per_app" ON "release_tests" USING btree ("app_id") WHERE "release_tests"."status" in ('dispatching', 'running');

-- Ultimo segno di vita del collaudatore (a ogni giro e durante l'attesa di un comando): lo sweeper chiude un collaudo senza agente
ALTER TABLE "release_tests" ADD COLUMN IF NOT EXISTS "agent_seen_at" timestamp;
