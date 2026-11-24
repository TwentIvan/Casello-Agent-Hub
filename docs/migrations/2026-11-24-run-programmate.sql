-- Run programmate (issue #107): un innesco di tipo `schedule` avvia le run di un agente secondo un'espressione cron a 5 campi
-- nell'ora italiana; `next_poll_at` è la prossima run. Additiva e idempotente, niente `-post`: la applica il deploy.
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- Il valore `schedule` si usa solo nel CHECK, con il confronto sul testo (kind::text).

ALTER TYPE "public"."trigger_kind" ADD VALUE IF NOT EXISTS 'schedule';

ALTER TABLE "agent_triggers" ADD COLUMN IF NOT EXISTS "cron" text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_triggers_schedule_check') THEN
    ALTER TABLE "agent_triggers" ADD CONSTRAINT "agent_triggers_schedule_check" CHECK ("kind"::text <> 'schedule' OR ("cron" IS NOT NULL AND "next_poll_at" IS NOT NULL));
  END IF;
END $$;
