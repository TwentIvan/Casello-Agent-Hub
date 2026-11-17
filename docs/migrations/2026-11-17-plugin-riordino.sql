-- Riordino del plugin, parte A (Botcave): nomi dei bot e azioni per pagina sull'App, pagine viste dal plugin, conversazioni del Responsabile
-- legate all'App, proposte di tipo `page_actions` (senza capitolo). Additiva e idempotente, niente `-post`: la applica il deploy.
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- Il valore `page_actions` si usa solo nel CHECK, con il confronto sul testo (kind::text).

ALTER TYPE "public"."plan_proposal_kind" ADD VALUE IF NOT EXISTS 'page_actions';

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "alfred_name" varchar(40);
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "lucius_name" varchar(40);
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "lead_name" varchar(40);
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "page_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "embed_pages_seen" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "lead_conversations" ADD COLUMN IF NOT EXISTS "app_id" integer;

DO $$ BEGIN
  ALTER TABLE "lead_conversations" ADD CONSTRAINT "lead_conversations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "plan_proposals" ALTER COLUMN "chapter" DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_proposals_chapter_check') THEN
    ALTER TABLE "plan_proposals" ADD CONSTRAINT "plan_proposals_chapter_check" CHECK ("kind"::text = 'page_actions' OR "chapter" IS NOT NULL);
  END IF;
END $$;

UPDATE "lead_conversations" SET "app_id" = (SELECT "id" FROM "apps" WHERE "slug" = 'casello') WHERE "app_id" IS NULL;
UPDATE "apps" SET "lead_name" = 'Barbara' WHERE "slug" = 'casello' AND "lead_name" IS NULL;
