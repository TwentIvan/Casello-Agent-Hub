-- Merge automatico delle PR delle squadre di Botcave: voce `merge` della coda «Da confermare» (PR che toccano migrazioni o
-- schema) e istante del merge fatto da Botcave su `team_code_tasks` (limite orario per squadra). Additiva e idempotente.
-- ALTER TYPE ... ADD VALUE non può stare in una transazione esplicita: non avvolgere lo script in BEGIN/COMMIT.
-- Da applicare su Neon PRIMA del merge. Nessun `-post`.

ALTER TYPE "public"."pending_action_kind" ADD VALUE IF NOT EXISTS 'merge';

ALTER TABLE "team_code_tasks" ADD COLUMN IF NOT EXISTS "botcave_merged_at" timestamp;
