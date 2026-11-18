-- Ciclo di evoluzione automatica 3c (Botcave): squadra del ciclo, giro che segue il lavoro, PLAN approvato dal ciclo.
-- Additiva e idempotente, niente `-post`: la applica il deploy. `ALTER TYPE … ADD VALUE` fuori da una transazione esplicita.

ALTER TYPE "public"."team_event_type" ADD VALUE IF NOT EXISTS 'giro_evoluzione';

ALTER TABLE "pending_actions" ADD COLUMN IF NOT EXISTS "decided_by_cycle" boolean DEFAULT false NOT NULL;

ALTER TABLE "evolution_rounds" ADD COLUMN IF NOT EXISTS "team_instance_id" integer;
ALTER TABLE "evolution_rounds" ADD COLUMN IF NOT EXISTS "work_id" integer;
ALTER TABLE "evolution_rounds" ADD COLUMN IF NOT EXISTS "pending_action_id" integer;
ALTER TABLE "evolution_rounds" ADD COLUMN IF NOT EXISTS "implementation_started_at" timestamp;

DO $$ BEGIN
  ALTER TABLE "evolution_rounds" ADD CONSTRAINT "evolution_rounds_team_instance_id_team_instances_id_fk" FOREIGN KEY ("team_instance_id") REFERENCES "public"."team_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "evolution_rounds" ADD CONSTRAINT "evolution_rounds_work_id_team_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."team_works"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "evolution_rounds" ADD CONSTRAINT "evolution_rounds_pending_action_id_pending_actions_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "public"."pending_actions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
